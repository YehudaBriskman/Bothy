// Notifications - who is told when an alert fires, and whether telling them worked.
//
// ── WHY THIS PAGE EXPLAINS RATHER THAN CONFIGURES ───────────────────────────
//
// The obvious build here was a form over Grafana's contact-point API. It was the
// wrong build, for three reasons found by looking at the box rather than at the
// plan:
//
//  1. THE RECIPIENT IS ALREADY RIGHT. On 2026-10-11 this box had been failing to
//     deliver every alert email for at least four days - 231 failures over 72
//     hours, and not one success. The recipient was correct the whole time. The
//     SMTP password was rejected (535 BadCredentials). A form for choosing who to
//     email would not have fixed that, and would not have revealed it either.
//  2. THE CONTACT POINT IS FILE-PROVISIONED. contactpoints.yml is read by
//     Grafana's provisioning at start-up; a resource created that way is not the
//     API's to rewrite. A form would be writing to a surface that is overwritten
//     on the next `just up-monitoring`.
//  3. IT WOULD COST A GATE AND A CREDENTIAL. Grafana has its own login, so the
//     route would need a credential injected at the edge - the pattern
//     Monitoring.tsx already declines, in those words, for the far smaller prize
//     of showing a rule's firing state.
//
// So this page does the one thing that was actually missing: it says where an
// alert goes, and whether the last attempt to send one worked. Both of those are
// read through routes that ALREADY EXIST - bothy-files for the two provisioning
// files (viewer), and /-/api/loki/query_range for Grafana's own log lines. No new
// route, no new gate, no new power, nothing added to SECURITY.md's counts.
//
// ── WHY THERE IS NO "SEND A TEST" BUTTON ────────────────────────────────────
//
// Because the box is already running the test, continuously: `update_stale` has
// been firing for days, so the live failure IS the proof and a button would only
// reproduce it. When nothing is firing there is nothing to prove from here, and
// the page says so and points at the Test button Grafana already has on its own
// contact-point page - which costs nothing and needs no route of ours.

import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { SettingBlock } from '../../components/settings/SettingBlock';
import { Cmd, Fact, Loading, Refusal, When, useLoad } from '../../components/settings/bits';
import { StatusIcon } from '../../lib/icons';
import { readStackFile } from '../../lib/stack-config';
import {
  CONTACT_POINTS, NOTIFY_POLICIES,
  parseContactPoints, parseNotifyPolicies, matcherText, envRefName,
  summariseDelivery, ATTEMPT_MARKER, FAILURE_MARKER,
  type ContactPoint, type NotifyRoute, type DeliveryState,
} from '../../lib/notifications';
import { fetchLogs } from '../../lib/logs';
import { filesHref } from '../files/routes';
import { Button, buttonClass } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';

export function NotificationsSettings() {
  return (
    <>
      <SettingBlock id="delivery-path" badge="read-only · viewer"><Path /></SettingBlock>
      <SettingBlock id="delivery-state" badge="live · read-only"><State /></SettingBlock>
      <SettingBlock id="notification-changes" badge="read-only"><Changes /></SettingBlock>
    </>
  );
}

const grafanaAt = (path: string) => `http://${location.hostname}:3000${path}`;

// ── where an alert goes ─────────────────────────────────────────────────────

function Path() {
  const { data, error, loading, reload } = useLoad(async (signal) => {
    const [cp, pol] = await Promise.all([
      readStackFile(CONTACT_POINTS, signal),
      readStackFile(NOTIFY_POLICIES, signal),
    ]);
    return {
      points: parseContactPoints(cp.content),
      policy: parseNotifyPolicies(pol.content),
    };
  });
  if (loading) return <Loading rows={5} />;
  if (error || !data) {
    return (
      <>
        <Refusal error={error} needs="viewer" what="the alerting provisioning files" />
        <Button variant="ghost" size="sm" onClick={reload}>Retry</Button>
      </>
    );
  }
  const { points, policy } = data;
  const routes: NotifyRoute[] = [...(policy.root ? [policy.root] : []), ...policy.routes];
  return (
    <>
      <p className="set-lede">
        A rule fires, the routing tree below picks a contact point, and that contact point is written to.
        {points.length === 1
          ? ' There is one contact point and one recipient on this box - it is a one-person machine, and the chain is correspondingly short.'
          : ` There are ${points.length} contact points.`}
      </p>

      {points.length === 0
        ? <p className="set-empty">The provisioning file declares no contact point. Nothing is written to when an alert fires.</p>
        : <div className="kv-list">{points.map((p) => <Point key={`${p.name}/${p.uid}`} point={p} />)}</div>}

      <div className="set-subsection">
        <h3 className="set-h3">Routing <span className="set-h3-sub">first match wins, top down</span></h3>
        <div className="tbl-wrap scroll-shade set-tbl">
          <table className="tbl as-cards">
            <thead>
              <tr>
                <th scope="col">Matches</th><th scope="col">Goes to</th>
                <th scope="col">Waits</th><th scope="col">Then every</th><th scope="col">Repeats every</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((r) => (
                <tr key={r.line}>
                  <td data-label="Matches">
                    {r.matchers.length === 0
                      ? <><b>everything</b><span className="set-cell-sub">the root route - no matchers</span></>
                      : r.matchers.map((m) => <span key={m.join()} className="mono set-pill">{matcherText(m)}</span>)}
                  </td>
                  <td className="mono" data-label="Goes to">{r.receiver ?? <span className="dim">-</span>}</td>
                  <td className="tnum" data-label="Waits">{r.groupWait ?? <Inherited />}</td>
                  <td className="tnum" data-label="Then every">{r.groupInterval ?? <Inherited />}</td>
                  <td className="tnum" data-label="Repeats every">{r.repeatInterval ?? <Inherited />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {policy.root && policy.root.groupBy.length > 0 && (
          <p className="set-note set-tbl-note">
            Alerts are batched by {policy.root.groupBy.map((g, i) => (
              <span key={g}>{i > 0 && ' + '}<span className="mono">{g}</span></span>
            ))}, so one email covers every alert sharing those labels rather than one email each.
          </p>
        )}
      </div>

      <div className="set-actions">
        <span className="set-note">
          From <Link className="link mono" to={filesHref('read', 'stacks', CONTACT_POINTS)}>{CONTACT_POINTS}</Link>{' '}
          and <Link className="link mono" to={filesHref('read', 'stacks', NOTIFY_POLICIES)}>{NOTIFY_POLICIES}</Link>.
          The rules that feed this are in <Link className="link" to="/settings/monitoring?block=alert-rules">Alert rules</Link>.
        </span>
      </div>
    </>
  );
}

/** An interval a route does not set is the parent's, and saying "4h" here would
 *  be a wrong fact rather than a missing one. */
function Inherited() {
  return <span className="dim" title="not set on this route - it takes the root's">inherited</span>;
}

function Point({ point }: { point: ContactPoint }) {
  const envKey = envRefName(point.addresses);
  return (
    <Fact label={`Contact point “${point.name}”`}>
      <span className="mono">{point.type ?? 'unknown type'}</span>
      {' · '}
      {point.addresses == null
        ? <span className="dim">no address in the file</span>
        : envKey
          // NOT printed as an inbox: the file holds a variable, and Grafana
          // substitutes it at start-up from the environment. The page would be
          // inventing a recipient if it showed this as an address.
          ? <>the value of <span className="mono">${envKey}</span></>
          : <span className="mono">{point.addresses}</span>}
      {envKey && (
        <span className="set-note">
          Set in <span className="mono">.env</span> and passed to Grafana by{' '}
          <Link className="link mono" to={filesHref('read', 'stacks', 'monitoring/compose.yml')}>monitoring/compose.yml</Link>.
          The address itself is not in any file this page can read, so it is not shown rather than guessed -{' '}
          <Link className="link" to="/settings/credentials?block=env-keys">Keys in .env</Link> says whether it is set.
        </span>
      )}
    </Fact>
  );
}

// ── whether it arrives ──────────────────────────────────────────────────────

const WINDOW_SECONDS = 86_400;

/**
 * The verdict's treatment.
 *
 * `no-failures` is deliberately NOT `up`. Grafana logs a notification FAILURE at
 * its default level and no success at all, so "no failures" is the absence of
 * bad news and not the presence of good news. Painting it green would be the
 * page lying on the data's behalf; checks/notifications.mjs asserts it does not.
 */
const VERDICT: Record<DeliveryState['verdict'], { status: 'down' | 'unknown' | 'dormant'; head: string }> = {
  failing: { status: 'down', head: 'Alert email is not getting through.' },
  'no-failures': { status: 'unknown', head: 'Grafana tried, and recorded no failure.' },
  idle: { status: 'dormant', head: 'Nothing has needed sending.' },
};

function State() {
  const { data, error, loading, reload } = useLoad(async (signal) => {
    // Two filtered queries rather than one unfiltered one: the attempt marker
    // and the failure marker cannot be expressed as a single `|=`, and an
    // unfiltered 24-hour pull of a chatty container would truncate the oldest
    // lines - which is exactly where a failure that stopped recurring would be.
    const source = { kind: 'container' as const, selector: '{container="grafana"}' };
    const [attempts, failures] = await Promise.all([
      fetchLogs(source, { rangeSeconds: WINDOW_SECONDS, search: ATTEMPT_MARKER, signal }),
      fetchLogs(source, { rangeSeconds: WINDOW_SECONDS, search: FAILURE_MARKER, signal }),
    ]);
    return summariseDelivery([...attempts.lines, ...failures.lines]);
  });
  if (loading) return <Loading rows={4} />;
  if (error || !data) {
    return (
      <>
        <Refusal error={error} what="Grafana's notification log" />
        <Button variant="ghost" size="sm" onClick={reload}>Retry</Button>
      </>
    );
  }
  const v = VERDICT[data.verdict];
  const last = data.last;
  return (
    <>
      <div className="set-verdict" data-state={data.verdict}>
        <StatusIcon status={v.status} />
        <div className="set-verdict-b">
          <p className="set-verdict-h">{v.head}</p>
          <p className="set-lede">
            In the last 24 hours Grafana handed alerts to its notifier{' '}
            <b className="tnum">{data.attempts}</b> time{data.attempts === 1 ? '' : 's'} and reported{' '}
            <b className="tnum">{data.failures}</b> delivery failure{data.failures === 1 ? '' : 's'}.
            {data.verdict === 'no-failures' && (
              <> At its current log level Grafana records a failure and never a success, so this is the absence
                of bad news rather than a delivery receipt.</>
            )}
            {data.verdict === 'idle' && <> No rule has fired in the window, so nothing has been tested.</>}
          </p>
        </div>
      </div>

      {last && (
        <div className="set-subsection">
          <div className="kv-list">
            <Fact label="Last failure">
              <When iso={new Date(last.ts).toISOString()} stamp />
            </Fact>
            {last.alertname && <Fact label="Which alert">{last.alertname}</Fact>}
            {last.receiver && <Fact label="Which contact point"><span className="mono">{last.receiver}</span></Fact>}
            {last.cause && (
              <Fact label="What went wrong">
                <span className="set-warn">{last.cause.what}</span>
                <span className="set-note">
                  {last.cause.fix.split(/(`[^`]+`)/g).map((t, i) => (t.startsWith('`') && t.endsWith('`')
                    ? <Cmd key={i}>{t.slice(1, -1)}</Cmd>
                    : <span key={i}>{t}</span>))}
                </span>
              </Fact>
            )}
            {last.cause?.key && (
              <Fact label="The key to change">
                <span className="mono">{last.cause.key}</span>
                <span className="set-note">
                  Its value is never shown here -{' '}
                  <Link className="link" to="/settings/credentials?block=env-keys">Keys in .env</Link> says
                  whether it is set and how to rotate it. <b>Set is not the same as accepted</b>: this one is set,
                  and the mail server is refusing it.
                </span>
              </Fact>
            )}
            <Fact label="What Grafana said">
              <code className="mono set-wrap set-raw-err">{last.error}</code>
            </Fact>
          </div>
        </div>
      )}

      <div className="set-actions">
        <Button variant="ghost" size="sm" onClick={reload}>Refresh</Button>
        <a className={buttonClass({ variant: 'ghost', size: 'sm' })} href={grafanaAt('/alerting/notifications')}
          target="_blank" rel="noopener noreferrer">
          <Icon icon={ExternalLink} size="sm" /> Test it in Grafana
        </a>
        <span className="set-note">
          Read from Grafana's own log lines through Loki - the same store every service's logs come from, so this
          needs no route Bothy did not already have, and no Grafana credential.
          {data.verdict === 'failing'
            ? ' There is no "send a test" button because the box is already sending them: the failure above is live.'
            : ' Grafana\'s own contact-point page has a Test button, which is the cheapest way to prove the path end to end.'}
        </span>
      </div>
    </>
  );
}

// ── changing it ─────────────────────────────────────────────────────────────

const KEYS: { key: string; what: string }[] = [
  { key: 'ALERT_EMAIL_TO', what: 'The address every alert is sent to.' },
  { key: 'GF_SMTP_ENABLED', what: 'Whether Grafana will send mail at all. With this false, an alert fires and nothing leaves the box.' },
  { key: 'GF_SMTP_HOST', what: 'The mail server and port.' },
  { key: 'GF_SMTP_USER', what: 'The account Grafana logs in as.' },
  { key: 'GF_SMTP_PASSWORD', what: 'That account\'s password. For Gmail, a 16-character app password with the spaces stripped.' },
  { key: 'GF_SMTP_FROM_ADDRESS', what: 'The From address, which the server usually requires the account be allowed to send as.' },
  { key: 'GF_SMTP_STARTTLS_POLICY', what: 'How TLS is negotiated. 587 wants StartTLS; 465 wants none.' },
];

function Changes() {
  return (
    <>
      <p className="set-lede">
        Everything on this page comes from two provisioning files and seven keys in <span className="mono">.env</span>.
        None of it is editable from here, and the reason is not that nobody got round to it.
      </p>

      <div className="tbl-wrap scroll-shade set-tbl">
        <table className="tbl as-cards">
          <thead><tr><th scope="col">Key in .env</th><th scope="col">What it decides</th></tr></thead>
          <tbody>
            {KEYS.map((k) => (
              <tr key={k.key}>
                <td className="mono" data-label="Key in .env">{k.key}</td>
                <td className="set-wrap" data-label="What it decides">{k.what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="kv-list">
        <Fact label="Changing a value">
          Edit <span className="mono">.env</span> on the box, then <Cmd>just up-monitoring</Cmd>
          <span className="set-note">
            Grafana reads all seven at start-up, so a change does nothing until the container is recreated.
          </span>
        </Fact>
        <Fact label="Changing who is written to, or adding a channel">
          Edit <Link className="link mono" to={filesHref('read', 'stacks', CONTACT_POINTS)}>{CONTACT_POINTS}</Link>,
          then <Cmd>just up-monitoring</Cmd>
          <span className="set-note">
            A Slack or webhook channel is another entry in that file. An <span className="mono">editor</span> can
            already write it through Files; applying it is a host job.
          </span>
        </Fact>
        <Fact label="Why not from here">
          A contact point is <b>provisioned from a file</b>, so Grafana's API does not own it - a form here would
          write to a surface that the next <span className="mono">just up-monitoring</span> overwrites. Reaching that
          API at all would also need a Grafana credential injected at the edge, which is the pattern{' '}
          <Link className="link" to="/settings/monitoring?block=alert-rules">Monitoring</Link> already declines for
          the smaller prize of a rule's firing state. The honest surface for this is the file, which Files already
          serves.
          <span className="set-note">
            And the fault this page was built to find was never a missing form: the recipient was correct for the
            whole time no mail was arriving. A password was being refused.
          </span>
        </Fact>
      </div>
    </>
  );
}
