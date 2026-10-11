// Where an alert goes after Grafana decides to fire it, and whether it arrived.
//
// IMPORTS NOTHING, so checks/notifications.mjs can compile it with a bare tsc
// and run a truth table over it - the same reason lib/settings-index.ts stays
// import-free. The page does the fetching; everything that can be got wrong is
// a pure function here.
//
//   monitoring/provisioning/alerting/contactpoints.yml   who is written to
//   monitoring/provisioning/alerting/policies.yml        when, and how often
//   Grafana's own log lines, through Loki                whether it worked
//
// The two parsers are regexes over one known file each, by their fixed
// indentation, exactly like parseAlertRules in lib/stack-config.ts: the browser
// bundle has no YAML parser and these two shapes do not justify one. Each says
// `null` rather than guessing when its line is not there.
//
// ── WHY THE VERDICT HAS THREE VALUES AND NOT TWO ────────────────────────────
//
// Measured on this box, 2026-10-11: at Grafana's default log level the notifier
// logs a FAILURE (`msg="Notify for alerts failed"`) and never a success. Over 72
// hours there were 231 failures and 0 success lines - not because nothing
// succeeded, but because "Notify success" is a debug-level line that is not
// being emitted. So the absence of failures is NOT a delivery receipt, and a
// green tick here would be a lie told by omission. `no-failures` says exactly
// what was observed and no more.

export const CONTACT_POINTS = 'monitoring/provisioning/alerting/contactpoints.yml';
export const NOTIFY_POLICIES = 'monitoring/provisioning/alerting/policies.yml';

const unq = (s: string) => s.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');

// ── who gets written to ─────────────────────────────────────────────────────

export interface ContactPoint {
  /** The name a notification policy routes to. */
  name: string;
  uid: string | null;
  /** email, slack, webhook... whatever Grafana calls the integration. */
  type: string | null;
  /** The literal from the file. `$ALERT_EMAIL_TO` is a VARIABLE, not an address:
   *  Grafana substitutes it from the environment at start-up, so the real
   *  recipient is not in this file and the page must not pretend it is. */
  addresses: string | null;
  line: number;
}

/** True when a value is an unexpanded `$VAR` / `${VAR}` rather than a literal. */
export function isEnvRef(value: string | null): boolean {
  return value != null && /^\$\{?[A-Z_][A-Z0-9_]*\}?$/.test(value.trim());
}

/** The environment variable a `$VAR` value names, without the sigil. */
export function envRefName(value: string | null): string | null {
  if (!isEnvRef(value)) return null;
  return (value as string).trim().replace(/^\$\{?/, '').replace(/\}$/, '');
}

export function parseContactPoints(text: string): ContactPoint[] {
  const out: ContactPoint[] = [];
  let name = '';
  let cur: ContactPoint | null = null;
  text.split('\n').forEach((raw, i) => {
    if (raw.trimStart().startsWith('#')) return;
    let m: RegExpExecArray | null;
    // `    name: email` - the contact point's own name, which a policy routes to.
    if ((m = /^\s{4}name:\s*(.+)$/.exec(raw))) { name = unq(m[1]); return; }
    // `      - uid: email_default` - one receiver (integration) inside it.
    if ((m = /^\s{6}- uid:\s*(.+)$/.exec(raw))) {
      cur = { name, uid: unq(m[1]), type: null, addresses: null, line: i + 1 };
      out.push(cur);
      return;
    }
    if (!cur) return;
    const c = cur as ContactPoint;
    if ((m = /^\s{8}type:\s*(.+)$/.exec(raw))) c.type = unq(m[1]);
    else if ((m = /^\s{10}addresses:\s*(.+)$/.exec(raw))) c.addresses = unq(m[1]);
  });
  return out;
}

// ── when, and how often ─────────────────────────────────────────────────────

export interface NotifyRoute {
  /** The contact point this route sends to. */
  receiver: string | null;
  /** `["severity", "=", "info"]` triples, as written. Empty on the root route,
   *  which is what makes it the default: it matches everything. */
  matchers: string[][];
  groupBy: string[];
  groupWait: string | null;
  groupInterval: string | null;
  repeatInterval: string | null;
  line: number;
}

export interface NotifyPolicy {
  /** The root route. Every alert enters here. */
  root: NotifyRoute | null;
  /** Child routes, in file order. The FIRST match wins and stops the walk, so
   *  order is behaviour, not presentation. */
  routes: NotifyRoute[];
}

const list = (s: string): string[] => {
  const inner = /^\[(.*)\]$/.exec(s.trim());
  if (!inner) return [unq(s)].filter(Boolean);
  return inner[1].split(',').map((x) => unq(x)).filter(Boolean);
};

export function parseNotifyPolicies(text: string): NotifyPolicy {
  let root: NotifyRoute | null = null;
  const routes: NotifyRoute[] = [];
  // Which route the indented keys below currently belong to.
  let cur: NotifyRoute | null = null;
  const blank = (line: number): NotifyRoute => ({
    receiver: null, matchers: [], groupBy: [],
    groupWait: null, groupInterval: null, repeatInterval: null, line,
  });
  text.split('\n').forEach((raw, i) => {
    if (raw.trimStart().startsWith('#')) return;
    let m: RegExpExecArray | null;
    // `  - orgId: 1` opens the root policy.
    if (/^\s{2}- orgId:/.test(raw)) { root = blank(i + 1); cur = root; return; }
    // `      - receiver: email` opens a CHILD route, two levels in.
    if ((m = /^\s{6}- receiver:\s*(.+)$/.exec(raw))) {
      const child = blank(i + 1);
      child.receiver = unq(m[1]);
      routes.push(child);
      cur = child;
      return;
    }
    if (!cur) return;
    const c = cur as NotifyRoute;
    // The root's keys sit at 4 spaces, a child's at 8. One branch for both: a
    // key belongs to whichever route was opened last, which is how YAML reads.
    if ((m = /^\s{4,8}receiver:\s*(.+)$/.exec(raw))) { if (!c.receiver) c.receiver = unq(m[1]); }
    else if ((m = /^\s{4,8}group_by:\s*(.+)$/.exec(raw))) c.groupBy = list(m[1]);
    else if ((m = /^\s{4,8}group_wait:\s*(.+)$/.exec(raw))) c.groupWait = unq(m[1]);
    else if ((m = /^\s{4,8}group_interval:\s*(.+)$/.exec(raw))) c.groupInterval = unq(m[1]);
    else if ((m = /^\s{4,8}repeat_interval:\s*(.+)$/.exec(raw))) c.repeatInterval = unq(m[1]);
    else if ((m = /^\s{10}- \[(.*)\]\s*$/.exec(raw))) c.matchers.push(list(`[${m[1]}]`));
  });
  return { root, routes };
}

/** What a matcher says in one line, e.g. `severity = info`. */
export function matcherText(triple: readonly string[]): string {
  return triple.length === 3 ? `${triple[0]} ${triple[1]} ${triple[2]}` : triple.join(' ');
}

// ── whether it worked ───────────────────────────────────────────────────────

/** Grafana's sender logs this every time it hands alerts to the notifier. */
export const ATTEMPT_MARKER = 'Sending alerts to local notifier';
/** ...and this when delivery fails. There is no success line at this log level. */
export const FAILURE_MARKER = 'Notify for alerts failed';

export interface MailCause {
  /** What went wrong, in a sentence a person can act on. */
  what: string;
  /** The .env key that holds the wrong value, when one key clearly owns it. */
  key: string | null;
  /** What to do about it. */
  fix: string;
}

/**
 * The named SMTP failures, in the order they are distinguishable.
 *
 * This exists because the raw error is unreadable and the remedy is not in it:
 * a 535 from Gmail means the app password in GF_SMTP_PASSWORD is wrong or has
 * been revoked, and nothing in the log line says `GF_SMTP_PASSWORD`. Anything
 * unrecognised falls through to `null` and the page shows the error verbatim
 * rather than guessing - a wrong remedy is worse than no remedy.
 */
export function classifyMailError(error: string): MailCause | null {
  const e = error.toLowerCase();
  if (/\b535\b|\b534\b|badcredentials|username and password not accepted|authentication failed|invalid login/.test(e)) {
    return {
      what: 'The mail server accepted the connection and rejected the login.',
      key: 'GF_SMTP_PASSWORD',
      fix: 'The password is wrong, or it was revoked. For Gmail it must be a 16-character app password with its spaces stripped, not the account password. Replace it in .env, then `just up-monitoring`.',
    };
  }
  if (/no such host|name resolution|dial tcp|connection refused|i\/o timeout|network is unreachable/.test(e)) {
    return {
      what: 'The mail server could not be reached at all.',
      key: 'GF_SMTP_HOST',
      fix: 'Check the host and port, and that this box has egress on it. Then `just up-monitoring`.',
    };
  }
  if (/x509|certificate|tls|ssl/.test(e)) {
    return {
      what: 'The connection was made but the TLS handshake failed.',
      key: 'GF_SMTP_STARTTLS_POLICY',
      fix: 'The policy and the port disagree, or the certificate is not trusted. 587 wants StartTLS; 465 wants none. Then `just up-monitoring`.',
    };
  }
  if (/\b55[0-9]\b|relay access denied|sender address rejected|not allowed to send/.test(e)) {
    return {
      what: 'The login worked and the server refused the sender or the recipient.',
      key: 'GF_SMTP_FROM_ADDRESS',
      fix: 'The From address usually has to be one the account is allowed to send as. Then `just up-monitoring`.',
    };
  }
  return null;
}

export interface DeliveryFailure {
  ts: number;
  /** The error Grafana reported, unescaped and flattened to one line. */
  error: string;
  /** Which alert failed to go out, when the line names one. */
  alertname: string | null;
  /** The contact point that failed, e.g. `email`. */
  receiver: string | null;
  cause: MailCause | null;
}

export type DeliveryVerdict = 'failing' | 'no-failures' | 'idle';

export interface DeliveryState {
  /** Lines that handed alerts to the notifier. */
  attempts: number;
  failures: number;
  /** The newest failure, which is the one worth reading. */
  last: DeliveryFailure | null;
  verdict: DeliveryVerdict;
}

/**
 * `err="..."` with its escaped quotes, flattened to something readable.
 *
 * The escaping is DOUBLE in the real lines: Grafana quotes the SMTP reply inside
 * its own quoted `err=` value, so a newline arrives as `\\n` and a quote as
 * `\\"`. Each pattern therefore matches a RUN of backslashes (`\\+`), not one -
 * matching one leaves the other behind, and the error renders with stray
 * backslashes in the middle of the sentence.
 */
export function extractError(line: string): string | null {
  const m = /err="((?:[^"\\]|\\.)*)"/.exec(line);
  if (!m) return null;
  const text = m[1]
    .replace(/\\+n/g, ' ')
    .replace(/\\+t/g, ' ')
    .replace(/\\+"/g, '"')
    .replace(/\\{2,}/g, '\\')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

/** The alert the failed batch was about, out of `aggrGroup=`. */
export function extractAlertname(line: string): string | null {
  const m = /alertname=\\?"(.*?)\\?"/.exec(line);
  return m && m[1] ? m[1] : null;
}

/** The contact point that failed, out of the `email/email[0]: ...` prefix. */
export function extractReceiver(line: string): string | null {
  const m = /err="([a-z0-9_-]+)\//i.exec(line);
  return m ? m[1] : null;
}

export interface NotifyLine { ts: number; text: string }

/**
 * Read a window of Grafana's log lines into one verdict.
 *
 * `no-failures` rather than `delivering` is deliberate - see the note at the top
 * of this file. The only thing these logs can prove is a failure.
 */
export function summariseDelivery(lines: readonly NotifyLine[]): DeliveryState {
  let attempts = 0;
  let failures = 0;
  let last: DeliveryFailure | null = null;
  for (const l of lines) {
    if (l.text.includes(FAILURE_MARKER)) {
      failures++;
      const error = extractError(l.text) ?? 'Grafana did not say why.';
      if (!last || l.ts > last.ts) {
        last = {
          ts: l.ts,
          error,
          alertname: extractAlertname(l.text),
          receiver: extractReceiver(l.text),
          cause: classifyMailError(error),
        };
      }
    } else if (l.text.includes(ATTEMPT_MARKER)) {
      attempts++;
    }
  }
  const verdict: DeliveryVerdict = failures > 0 ? 'failing' : attempts > 0 ? 'no-failures' : 'idle';
  return { attempts, failures, last, verdict };
}
