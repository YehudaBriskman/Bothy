// Where an alert goes, and whether anything is actually delivering it.
//
// Two kinds of assertion here, and the second is the one that earns its keep:
//
//   1. A truth table over lib/notifications.ts - the parsers, the SMTP-error
//      classifier and the three-valued verdict.
//   2. The parsers run against the REAL provisioning files in this repo. A
//      regex parser over YAML fails SILENTLY and in the worst direction: if
//      somebody reshapes contactpoints.yml, parseContactPoints returns `[]` and
//      the page says "this box has no contact points", which is both wrong and
//      completely plausible. Nothing else in the suite would notice.
//
// The honesty assertion. `no-failures` must never be rendered or described as a
// success: at Grafana's default log level there IS no success line (measured
// 2026-10-11: 231 failures and 0 successes over 72 hours on this box), so the
// absence of failures proves nothing about delivery. A verdict named `ok`, or a
// page that draws `no-failures` with the `up` treatment, would be a lie told by
// omission - so both are asserted against here.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTACT_POINTS, NOTIFY_POLICIES,
  parseContactPoints, parseNotifyPolicies, matcherText,
  isEnvRef, envRefName,
  classifyMailError, extractError, extractAlertname, extractReceiver,
  summariseDelivery, ATTEMPT_MARKER, FAILURE_MARKER,
} from './notifications-mod.mjs';

const SRC = process.argv[2];
const REPO = process.argv[3];
let fails = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

// ── the real files in this repo ─────────────────────────────────────────────
const cpText = readFileSync(join(REPO, CONTACT_POINTS), 'utf8');
const polText = readFileSync(join(REPO, NOTIFY_POLICIES), 'utf8');

const points = parseContactPoints(cpText);
ok(points.length >= 1, `${CONTACT_POINTS} parses to at least one contact point`, `${points.length} found`);
ok(points.every((p) => p.name && p.type), 'every contact point has a name and a type', JSON.stringify(points.map((p) => `${p.name}/${p.type}`)));
ok(points.some((p) => p.type === 'email'), 'this box notifies by email');

const pol = parseNotifyPolicies(polText);
ok(pol.root !== null, `${NOTIFY_POLICIES} parses to a root route`);
ok(pol.root?.receiver === 'email', 'the root route sends to the `email` contact point', String(pol.root?.receiver));
ok(pol.root?.matchers.length === 0, 'the ROOT route has no matchers - that is what makes it the default');
ok((pol.root?.groupBy ?? []).length >= 1, 'the root route groups alerts', (pol.root?.groupBy ?? []).join('+'));
ok(!!pol.root?.repeatInterval, 'the root route repeats on an interval', String(pol.root?.repeatInterval));
ok(pol.routes.length >= 1, 'and there is at least one child route', `${pol.routes.length}`);
ok(pol.routes.every((r) => r.matchers.length >= 1),
  'every CHILD route has at least one matcher - a child with none would shadow the default for everything');

// Every receiver a policy routes to must be a contact point that exists. A typo
// here is the quietest failure in the whole chain: Grafana provisions happily
// and the alert goes nowhere at all.
const names = new Set(points.map((p) => p.name));
const dangling = [pol.root, ...pol.routes].filter((r) => r?.receiver && !names.has(r.receiver));
ok(dangling.length === 0, 'every route names a contact point that exists in contactpoints.yml',
  dangling.map((r) => r.receiver).join(','));

// ── the recipient is a VARIABLE, not an address ─────────────────────────────
// The page must not print `$ALERT_EMAIL_TO` as though it were an inbox.
const emailPoint = points.find((p) => p.type === 'email');
ok(isEnvRef(emailPoint?.addresses ?? null), 'the recipient in the file is an unexpanded $VAR, not a literal address',
  String(emailPoint?.addresses));
ok(envRefName(emailPoint?.addresses ?? null) === 'ALERT_EMAIL_TO', 'and it names ALERT_EMAIL_TO',
  String(envRefName(emailPoint?.addresses ?? null)));
ok(isEnvRef('$ALERT_EMAIL_TO') && isEnvRef('${ALERT_EMAIL_TO}'), 'both $VAR and ${VAR} are recognised');
ok(!isEnvRef('alerts@example.com') && !isEnvRef('') && !isEnvRef(null), 'a real address is not mistaken for a variable');
ok(!isEnvRef('$lower_case'), 'and a lowercase $word is not treated as an env var');

// ── parsing shapes, including the ones that are not there ───────────────────
ok(parseContactPoints('').length === 0 && parseNotifyPolicies('').root === null,
  'an empty file yields nothing rather than a guess');
ok(parseContactPoints('# name: decoy\n#       - uid: decoy\n').length === 0,
  'a commented-out contact point is not a contact point');
ok(parseNotifyPolicies('#  - orgId: 1\n#    receiver: decoy\n').root === null,
  'and a commented-out policy is not a policy');
ok(matcherText(['severity', '=', 'info']) === 'severity = info', 'a matcher reads as a sentence');

// Two receivers inside one contact point both carry its name - the name is what
// a policy routes to, so losing it on the second would make a route look dangling.
const two = parseContactPoints([
  'contactPoints:',
  '  - orgId: 1',
  '    name: both',
  '    receivers:',
  '      - uid: a',
  '        type: email',
  '        settings:',
  '          addresses: a@example.com',
  '      - uid: b',
  '        type: slack',
].join('\n'));
ok(two.length === 2 && two.every((p) => p.name === 'both'),
  'every receiver inside a contact point carries that contact point\'s name', JSON.stringify(two.map((p) => p.name)));
ok(two[0].addresses === 'a@example.com' && two[1].addresses === null,
  'a receiver with no addresses says null rather than borrowing the one above');

// A child route must not inherit the root's intervals by accident: an unset
// interval means "take the parent's", and printing the parent's number as the
// child's own is a wrong fact rather than a missing one.
const inherit = parseNotifyPolicies([
  'policies:',
  '  - orgId: 1',
  '    receiver: email',
  '    repeat_interval: 4h',
  '    routes:',
  '      - receiver: email',
  '        object_matchers:',
  '          - ["severity", "=", "info"]',
].join('\n'));
ok(inherit.routes[0].repeatInterval === null,
  'a child route with no repeat_interval of its own says null, not the root\'s 4h');
ok(inherit.root.repeatInterval === '4h', 'and the root keeps its own');

// ── the SMTP classifier ─────────────────────────────────────────────────────
// Each row is a real reply shape. The point of the classifier is that the remedy
// is NOT in the error: nothing in a 535 mentions GF_SMTP_PASSWORD.
const cause = (s) => classifyMailError(s)?.key ?? null;
ok(cause('failed to send email: 535 "5.7.8 Username and Password not accepted') === 'GF_SMTP_PASSWORD',
  'a 535 points at GF_SMTP_PASSWORD');
ok(cause('535 5.7.8 BadCredentials') === 'GF_SMTP_PASSWORD', 'so does a bare BadCredentials');
ok(cause('dial tcp: lookup smtp.example.com: no such host') === 'GF_SMTP_HOST',
  'an unreachable host points at GF_SMTP_HOST');
ok(cause('connection refused') === 'GF_SMTP_HOST', 'so does a refused connection');
ok(cause('x509: certificate signed by unknown authority') === 'GF_SMTP_STARTTLS_POLICY',
  'a TLS failure points at the StartTLS policy');
ok(cause('550 5.7.1 Sender address rejected') === 'GF_SMTP_FROM_ADDRESS',
  'a rejected sender points at the From address');
ok(classifyMailError('something nobody has seen before') === null,
  'an unrecognised error gets NO remedy - a wrong remedy is worse than none');
ok(classifyMailError('') === null, 'and neither does an empty one');
// Ordering matters: a 535 reply that happens to mention TLS must still be read
// as a credential failure, because that is the one the operator must act on.
ok(cause('535 authentication failed over tls') === 'GF_SMTP_PASSWORD',
  'credentials beat TLS when a reply mentions both');
ok(classifyMailError('535 BadCredentials').fix.includes('just up-monitoring'),
  'every remedy ends in the command that applies it');

// ── reading one real log line ───────────────────────────────────────────────
// Exactly as Loki returns it, captured from this box on 2026-10-11. The escaping
// is DOUBLE - Grafana quotes the SMTP reply inside its own quoted err= value.
const REAL_FAILURE = 'logger=ngalert.notifier t=2026-10-11T11:48:17.869193915Z level=error '
  + 'component=alertmanager orgID=1 component=dispatcher msg="Notify for alerts failed" num_alerts=2 '
  + 'err="email/email[0]: notify retry canceled due to unrecoverable error after 1 attempts: '
  + 'failed to send email: 535 \\"5.7.8 Username and Password not accepted. For more information, go to'
  + '\\\\n5.7.8  https://support.google.com/mail/?p=BadCredentials ffacd0b85a97d.20 - gsmtp\\"" '
  + 'aggrGroup="{}/{severity=\\"info\\"}:{alertname=\\"Update waiting for over 14 days\\", grafana_folder=\\"Alerts\\"}" '
  + 'alerts="[Update waiting for over 14 days[7ce5398][active]]"';
const REAL_ATTEMPT = 'logger=ngalert.sender.router rule_uid=update_stale org_id=1 '
  + 't=2026-10-11T11:48:49.634533291Z level=info msg="Sending alerts to local notifier" count=2';

const err = extractError(REAL_FAILURE);
ok(err !== null && err.includes('535'), 'the error comes out of err="..."', String(err).slice(0, 48));
// THE BUG THIS CAUGHT. Matching a single backslash leaves the other behind, and
// the sentence renders as `go to\ 5.7.8` in the middle of the remedy.
ok(!/\\/.test(err), 'and it carries no stray backslash from the DOUBLE escaping', String(err));
ok(!/\n/.test(err) && !/\s{2}/.test(err), 'it is one line with no run of spaces');
ok(extractAlertname(REAL_FAILURE) === 'Update waiting for over 14 days',
  'the alert that failed to go out is named', String(extractAlertname(REAL_FAILURE)));
ok(extractReceiver(REAL_FAILURE) === 'email', 'and so is the contact point that failed');
ok(extractError(REAL_ATTEMPT) === null && extractAlertname(REAL_ATTEMPT) === null,
  'a line with no err= yields null rather than an empty string');
ok(classifyMailError(err).key === 'GF_SMTP_PASSWORD', 'the real line classifies as a credential failure');

// ── the three-valued verdict ────────────────────────────────────────────────
ok(ATTEMPT_MARKER !== FAILURE_MARKER, 'the two markers are different strings');
const f = summariseDelivery([{ ts: 1, text: REAL_ATTEMPT }, { ts: 2, text: REAL_FAILURE }]);
ok(f.verdict === 'failing' && f.failures === 1 && f.attempts === 1,
  'a failure in the window is `failing`', JSON.stringify([f.verdict, f.attempts, f.failures]));
ok(f.last?.cause?.key === 'GF_SMTP_PASSWORD', 'and the newest failure carries its remedy');

// THE HONESTY ASSERTION. Attempts and no failures is NOT a delivery receipt.
const q = summariseDelivery([{ ts: 1, text: REAL_ATTEMPT }, { ts: 2, text: REAL_ATTEMPT }]);
ok(q.verdict === 'no-failures' && q.attempts === 2 && q.last === null,
  'attempts with no failure is `no-failures` - NOT a success, because Grafana logs no success line at this level',
  q.verdict);
ok(summariseDelivery([]).verdict === 'idle' && summariseDelivery([]).attempts === 0,
  'nothing in the window at all is `idle`');
ok(summariseDelivery([{ ts: 1, text: 'unrelated grafana chatter' }]).verdict === 'idle',
  'and lines that are neither marker do not count as an attempt');

// The newest failure wins, whatever order the lines arrive in. Loki is queried
// `direction=backward`, so they arrive NEWEST FIRST and a naive "first one wins"
// would be right by accident here and wrong the moment the sort changes.
const older = { ts: 10, text: REAL_FAILURE.replace('535 \\"5.7.8 Username and Password not accepted', '550 \\"sender rejected') };
const newer = { ts: 20, text: REAL_FAILURE };
ok(summariseDelivery([newer, older]).last.ts === 20 && summariseDelivery([older, newer]).last.ts === 20,
  'the NEWEST failure is the one reported, in either arrival order');
ok(summariseDelivery([newer, older]).failures === 2, 'and both are still counted');

// ── the page may not dress `no-failures` up as success ──────────────────────
// The verdict is honest in the data; this is the half that keeps it honest on
// screen. `--st-up` is the green treatment, and this is not a green state.
const page = readFileSync(join(SRC, 'pages/settings/Notifications.tsx'), 'utf8');
ok(/'no-failures'/.test(page), 'the page handles the no-failures verdict at all');
const upForNoFailures = /no-failures'\s*:\s*'up'/.test(page) || /'no-failures':\s*\{[^}]*status:\s*'up'/.test(page);
ok(!upForNoFailures, 'and it does NOT give no-failures the `up` status - absence of failure is not delivery');
ok(!/\b(delivered|delivering|working)\b/i.test(page.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')),
  'and never says "delivered" or "working" in anything it renders');

console.log(fails ? `\nFAILED: ${fails}` : '\nnotifications: all passed');
process.exit(fails ? 1 : 0);
