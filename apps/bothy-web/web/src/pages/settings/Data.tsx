// Data & refresh - how often this browser asks the box, what the charts open on,
// how long the box keeps history, and what Bothy has left in this browser.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { SettingBlock } from '../../components/settings/SettingBlock';
import { Choice, Loading, Refusal, useLoad } from '../../components/settings/bits';
import { announcePref, useDataPrefs } from '../../lib/usePrefs';
import { CHART_RANGES, KNOWN_KEYS, POLL_CHOICES, type ChartRange, type PollSeconds } from '../../lib/prefs';
import { LOKI_CONFIG, VM_COMPOSE, lokiRetention, readStackFile, vmRetention } from '../../lib/stack-config';
import { filesHref } from '../files/routes';
import { Button } from '../../components/ui/Button';

export function DataSettings() {
  const [data, setData] = useDataPrefs();
  const [poll, setPoll] = useState<PollSeconds | null>(null);
  const [range, setRange] = useState<ChartRange | null>(null);
  const pollV = poll ?? data.pollSeconds;
  const rangeV = range ?? data.chartRange;

  return (
    <>
      <SettingBlock
        id="poll"
        badge="this browser"
        dirty={poll !== null && poll !== data.pollSeconds}
        onSave={() => { setData({ ...data, pollSeconds: pollV }); setPoll(null); }}
        onDiscard={() => setPoll(null)}
        saveNote="The next poll uses it; nothing reloads."
      >
        <Choice<PollSeconds>
          label="Ask Docker and Traefik for the box’s state every"
          name="poll"
          value={pollV}
          onChange={setPoll}
          options={POLL_CHOICES.map((s) => ({
            value: s,
            label: `${s} seconds`,
            hint: s === 10 ? 'The default. A stopped container shows within ten seconds.'
              : s === 30 ? 'Lighter on a slow tailnet link.' : 'For a tab left open all day.',
          }))}
        />
        <p className="set-note">
          Unchanged by this: a hidden tab never polls, a focused tab refreshes at once, and three failures in a row back
          off to a minute. The charts keep their own cadence.
        </p>
      </SettingBlock>

      <SettingBlock
        id="chart-range"
        badge="this browser"
        dirty={range !== null && range !== data.chartRange}
        onSave={() => { setData({ ...data, chartRange: rangeV }); setRange(null); }}
        onDiscard={() => setRange(null)}
      >
        <Choice<ChartRange>
          label="Box vitals open on the last"
          name="chart-range"
          value={rangeV}
          onChange={setRange}
          options={CHART_RANGES.map((r) => ({ value: r, label: r }))}
        />
        <p className="set-note">The range buttons on the charts still switch it for the page you are on.</p>
      </SettingBlock>

      <SettingBlock id="retention" badge="read-only · viewer"><RetentionBlock /></SettingBlock>
      <SettingBlock id="local-data" badge="this browser"><LocalData /></SettingBlock>
    </>
  );
}

function RetentionBlock() {
  const { data, error, loading, reload } = useLoad(async (signal) => {
    const [vm, loki] = await Promise.all([readStackFile(VM_COMPOSE, signal), readStackFile(LOKI_CONFIG, signal)]);
    return { vm: vmRetention(vm.content), loki: lokiRetention(loki.content) };
  });
  if (loading) return <Loading rows={2} />;
  if (error) {
    return (
      <>
        <Refusal error={error} needs="viewer" what="the retention settings" />
        <Button variant="ghost" size="sm" onClick={reload}>Retry</Button>
      </>
    );
  }
  const rows = [
    { what: 'Metrics', who: 'VictoriaMetrics', r: data?.vm ?? null, file: VM_COMPOSE,
      note: 'Whole data parts are deleted once they fall outside the window, so the disk can briefly hold a little more.' },
    { what: 'Logs', who: 'Loki', r: data?.loki ?? null, file: LOKI_CONFIG,
      note: 'Enforced by the compactor; deletes run two hours after a chunk expires.' },
  ];
  return (
    <div className="tbl-wrap set-tbl">
      <table className="tbl">
        <thead>
          <tr><th scope="col">History</th><th scope="col">Kept for</th><th scope="col">Declared in</th></tr>
        </thead>
        <tbody>
          {rows.map((x) => (
            <tr key={x.what}>
              <td><b>{x.what}</b><span className="set-cell-sub">{x.who}</span></td>
              <td>
                {x.r ? <><b className="tnum">{x.r.human}</b> <span className="mono dim">{x.r.value}</span></> : <span className="dim">not found in the file</span>}
                <span className="set-cell-sub">{x.note}</span>
              </td>
              <td>
                <Link className="link mono" to={filesHref('read', 'stacks', x.file)}>{x.file}</Link>
                {x.r && <span className="set-cell-sub">line {x.r.line}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="set-note set-tbl-note">
        Read from the files on every visit, so this is what the next restart will apply. Changing it is an edit to that
        file and a <span className="mono">just up-monitoring</span>.
      </p>
    </div>
  );
}

function keysInBrowser(): { key: string; bytes: number }[] {
  const out: { key: string; bytes: number }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !/^(bothy-|portal-)/.test(k)) continue;
      out.push({ key: k, bytes: (localStorage.getItem(k) ?? '').length + k.length });
    }
  } catch { /* private mode: nothing is stored anyway */ }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

function LocalData() {
  const [, bump] = useState(0);
  const [confirmAll, setConfirmAll] = useState(false);
  const present = keysInBrowser();
  const total = present.reduce((n, k) => n + k.bytes, 0);
  const known = new Map(KNOWN_KEYS.map((k) => [k.key, k]));
  const clear = (keys: string[]) => {
    for (const k of keys) {
      try { localStorage.removeItem(k); } catch { /* not fatal */ }
      announcePref(k);
    }
    bump((n) => n + 1);
  };
  if (!present.length) {
    return <p className="set-empty">Bothy has nothing stored in this browser. Every page is at its defaults.</p>;
  }
  return (
    <>
      <div className="tbl-wrap set-tbl">
        <table className="tbl">
          <thead>
            <tr><th scope="col">Key</th><th scope="col">What it holds</th><th scope="col" className="num">Size</th><th scope="col"><span className="sr-only">Clear</span></th></tr>
          </thead>
          <tbody>
            {present.map((p) => (
              <tr key={p.key}>
                <td className="mono">{p.key}</td>
                <td>{known.get(p.key)?.what ?? <span className="dim">not a key this version of Bothy uses</span>}</td>
                <td className="num tnum">{p.bytes} B</td>
                <td className="set-cell-act">
                  <Button variant="ghost" size="sm" onClick={() => clear([p.key])} aria-label={`Clear ${p.key}`}>Clear</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="set-actions">
        {confirmAll ? (
          <>
            <Button variant="danger" size="sm" onClick={() => { clear(present.map((p) => p.key)); setConfirmAll(false); }}>
              Yes, clear all {present.length}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmAll(false)}>Keep them</Button>
            <span className="set-note">Resets the theme, sizes, layout and recents in this browser. Nothing on the box changes.</span>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmAll(true)}>Clear all Bothy data in this browser</Button>
            <span className="set-note tnum">{present.length} keys, {total} B. Other browsers and the box are not affected.</span>
          </>
        )}
      </div>
    </>
  );
}
