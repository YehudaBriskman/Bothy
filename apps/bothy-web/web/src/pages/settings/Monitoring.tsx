// Monitoring & alerts - what VictoriaMetrics scrapes, whether each target
// answered, and the alert rules Grafana evaluates.
//
// TARGETS are live: `up` and `scrape_duration_seconds` through the portal's
// existing read-only metrics route. ALERT RULES are definitions, read from the
// provisioning file through bothy-files (viewer). Their STATE - firing or not -
// lives in Grafana, behind Grafana's own login, and reaching it from here would
// need a credential injected at the edge (the bothy-prom.yml pattern). That route
// has not been added, and SECURITY.md would have to say why before it is, so the
// page links to Grafana for state rather than inventing one.

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { SettingBlock } from '../../components/settings/SettingBlock';
import { Loading, Refusal, useLoad } from '../../components/settings/bits';
import { StatusIcon } from '../../lib/icons';
import { ALERT_RULES, parseAlertRules, readStackFile } from '../../lib/stack-config';
import { filesHref } from '../files/routes';
import { Button, buttonClass } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';

interface Target { job: string; instance: string; up: boolean; duration: number | null }

async function loadTargets(signal: AbortSignal): Promise<Target[]> {
  const q = async (query: string) => {
    const r = await fetch(`/-/api/prom/query?${new URLSearchParams({ query })}`, { signal, cache: 'no-store' });
    const ct = r.headers.get('content-type') ?? '';
    if (!ct.includes('json')) {
      const e = new Error('the metrics route is not configured on this box - run `just bothy-prom-route`') as Error & { status: number; fromService: boolean };
      e.status = 503;
      e.fromService = true;
      throw e;
    }
    if (!r.ok) {
      const e = new Error(`VictoriaMetrics answered ${r.status}`) as Error & { status: number };
      e.status = r.status;
      throw e;
    }
    const body = await r.json() as { data?: { result?: { metric: Record<string, string>; value: [number, string] }[] } };
    return body.data?.result ?? [];
  };
  const [up, dur] = await Promise.all([q('up'), q('scrape_duration_seconds')]);
  const key = (m: Record<string, string>) => `${m.job}|${m.instance}`;
  const durations = new Map(dur.map((s) => [key(s.metric), Number(s.value[1])]));
  return up.map((s) => ({
    job: s.metric.job ?? '?',
    instance: s.metric.instance ?? '?',
    up: s.value[1] === '1',
    duration: durations.get(key(s.metric)) ?? null,
  })).sort((a, b) => Number(a.up) - Number(b.up) || a.job.localeCompare(b.job) || a.instance.localeCompare(b.instance));
}

export function MonitoringSettings() {
  return (
    <>
      <SettingBlock id="targets" badge="live · read-only"><Targets /></SettingBlock>
      <SettingBlock id="alert-rules" badge="read-only · viewer"><Rules /></SettingBlock>
    </>
  );
}

function Targets() {
  const { data, error, loading, reload } = useLoad((signal) => loadTargets(signal));
  const [onlyDown, setOnlyDown] = useState(false);
  if (loading) return <Loading rows={6} />;
  if (error) {
    return (
      <>
        <Refusal error={error} what="the scrape targets" />
        <Button variant="ghost" size="sm" onClick={reload}>Retry</Button>
      </>
    );
  }
  const all = data ?? [];
  const down = all.filter((t) => !t.up);
  const rows = onlyDown ? down : all;
  const jobs = new Set(all.map((t) => t.job)).size;
  return (
    <>
      <div className="set-toolbar">
        <p className="set-lede tnum">
          <b>{all.length - down.length} of {all.length}</b> targets answered their last scrape, across {jobs} jobs.
          {down.length > 0 && <> <b>{down.length}</b> did not.</>}
        </p>
        <label className="set-check set-check-inline">
          <input type="checkbox" checked={onlyDown} onChange={(e) => setOnlyDown(e.target.checked)} disabled={!down.length} />
          <span className="set-check-t">Only the ones that did not</span>
        </label>
        <Button variant="ghost" size="sm" onClick={reload}>Refresh</Button>
      </div>
      <div className="tbl-wrap scroll-shade set-tbl set-tbl-scroll">
        <table className="tbl as-cards">
          <thead>
            <tr><th scope="col">State</th><th scope="col">Job</th><th scope="col">Instance</th><th scope="col" className="num">Scrape took</th></tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={`${t.job}|${t.instance}`}>
                <td><StatusIcon status={t.up ? 'up' : 'down'} showLabel /></td>
                <td className="mono" data-label="Job">{t.job}</td>
                <td className="mono set-wrap" data-label="Instance">{t.instance}</td>
                <td className="num tnum" data-label="Scrape took">{t.duration == null ? '-' : `${(t.duration * 1000).toFixed(0)} ms`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="set-note set-tbl-note">
        Metrics are kept 15 days - see <Link className="link" to="/settings/data?block=retention">Retention</Link>.
      </p>
    </>
  );
}

function Rules() {
  const { data, error, loading, reload } = useLoad(async (signal) => parseAlertRules((await readStackFile(ALERT_RULES, signal)).content));
  const groups = useMemo(() => [...new Set((data ?? []).map((r) => r.group))], [data]);
  const grafana = `http://${location.hostname}:3000/alerting/list`;
  if (loading) return <Loading rows={4} />;
  if (error) {
    return (
      <>
        <Refusal error={error} needs="viewer" what="the alert rules" />
        <Button variant="ghost" size="sm" onClick={reload}>Retry</Button>
      </>
    );
  }
  return (
    <>
      {groups.map((g) => {
        const rules = (data ?? []).filter((r) => r.group === g);
        return (
          <div key={g} className="set-subsection">
            <h3 className="set-h3">{g} <span className="set-h3-sub">evaluated every {rules[0]?.interval ?? '?'}</span></h3>
            <div className="tbl-wrap scroll-shade set-tbl">
              <table className="tbl as-cards">
                <thead>
                  <tr><th scope="col">Rule</th><th scope="col">Severity</th><th scope="col">Fires after</th><th scope="col">Says</th></tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.uid}>
                      <td><b>{r.title}</b><span className="set-cell-sub mono">{r.uid} · line {r.line}</span></td>
                      <td className="mono" data-label="Severity">{r.severity ?? '-'}</td>
                      <td className="tnum" data-label="Fires after">{r.for ?? 'at once'}</td>
                      <td className="set-wrap" data-label="Says">{r.summary ?? <span className="dim">no summary</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      {!groups.length && <p className="set-empty">The provisioning file declares no rules.</p>}
      <div className="set-actions">
        <a className={buttonClass({ variant: 'ghost', size: 'sm' })} href={grafana} target="_blank" rel="noopener noreferrer">
          <Icon icon={ExternalLink} size="sm" /> Firing state in Grafana
        </a>
        <span className="set-note">
          Definitions from <Link className="link mono" to={filesHref('read', 'stacks', ALERT_RULES)}>{ALERT_RULES}</Link>.
          Whether a rule is firing is Grafana’s to say; it has its own login.
        </span>
      </div>
    </>
  );
}
