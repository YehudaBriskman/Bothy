// Audit log - the four append-only logs, newest first, through bothy-ops'
// GET /-/api/admin/audit (operator). Filtering and paging happen in the service
// over the last few megabytes of each log; the page says when a log was longer
// than that window rather than implying it has seen everything.
//
// The filters live in the URL query, so a filtered view is a link you can paste
// (navigation.md: decide whether filter state lives in the URL).

import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SettingBlock } from '../../components/settings/SettingBlock';
import { Loading, Refusal, When, useLoad } from '../../components/settings/bits';
import { fetchAudit, type AuditLogName, type AuditQuery } from '../../lib/admin';
import { Button } from '../../components/ui/Button';

const LOGS: { id: 'all' | AuditLogName; label: string; hint: string }[] = [
  { id: 'all', label: 'All', hint: 'Every log, merged by time' },
  { id: 'ops', label: 'Actions', hint: 'Container and cluster actions (bothy-ops)' },
  { id: 'files', label: 'File writes', hint: 'Saves and deletes in Files (bothy-files)' },
  { id: 'config', label: 'Config patches', hint: 'Form edits to compose labels and placement (bothy-files)' },
  { id: 'admin', label: 'Admin reads', hint: 'Who opened users, credentials, backups and this log' },
];
const PAGE = 50;

export function AuditSettings() {
  return (
    <SettingBlock id="audit-log" badge="read-only · operator">
      <AuditBody />
    </SettingBlock>
  );
}

function AuditBody() {
  const [params, setParams] = useSearchParams();
  const q: AuditQuery = {
    log: (LOGS.find((l) => l.id === params.get('log'))?.id ?? 'all'),
    who: params.get('who') ?? '',
    outcome: params.get('outcome') ?? '',
    action: params.get('action') ?? '',
    offset: Math.max(0, Number(params.get('offset') ?? 0) || 0),
    limit: PAGE,
  };
  const set = (patch: Record<string, string | number | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '' || v === 0 || v === 'all') next.delete(k);
      else next.set(k, String(v));
    }
    if (!('offset' in patch)) next.delete('offset');
    next.delete('block');
    setParams(next, { replace: true });
  };
  const sig = JSON.stringify(q);
  const { data, error, loading, reload } = useLoad((signal) => fetchAudit(q, signal), [sig]);
  const truncated = useMemo(() => Object.entries(data?.logs ?? {}).filter(([, v]) => v?.truncated).map(([k]) => k), [data]);

  return (
    <>
      <div className="set-filters" role="search" aria-label="Filter the audit log">
        <div className="seg-toggle set-seg" role="group" aria-label="Log">
          {LOGS.map((l) => (
            <button key={l.id} type="button" className={q.log === l.id ? 'on' : ''} aria-pressed={q.log === l.id}
              title={l.hint} onClick={() => set({ log: l.id })}>{l.label}</button>
          ))}
        </div>
        <label className="set-field">
          <span className="set-field-l">Who</span>
          <input className="set-input" type="search" defaultValue={q.who} placeholder="name@example.com"
            onKeyDown={(e) => { if (e.key === 'Enter') set({ who: (e.target as HTMLInputElement).value.trim() }); }}
            onBlur={(e) => { if (e.target.value.trim() !== q.who) set({ who: e.target.value.trim() }); }} />
        </label>
        <label className="set-field">
          <span className="set-field-l">Outcome</span>
          <select className="set-input" value={q.outcome} onChange={(e) => set({ outcome: e.target.value })}>
            <option value="">Any</option>
            {(data?.facets.outcome ?? (q.outcome ? [q.outcome] : [])).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        <label className="set-field">
          <span className="set-field-l">Action</span>
          <select className="set-input" value={q.action} onChange={(e) => set({ action: e.target.value })}>
            <option value="">Any</option>
            {(data?.facets.action ?? (q.action ? [q.action] : [])).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        {(q.who || q.outcome || q.action) && (
          <Button variant="ghost" size="sm" onClick={() => set({ who: null, outcome: null, action: null })}>Clear filters</Button>
        )}
      </div>

      {loading && !data ? <Loading rows={8} /> : error ? (
        <>
          <Refusal error={error} needs="operator" what="the audit log" />
          <Button variant="ghost" size="sm" onClick={reload}>Retry</Button>
        </>
      ) : data && (
        <>
          {data.entries.length === 0 ? (
            <p className="set-empty">
              {q.who || q.outcome || q.action ? 'No record matches these filters.' : 'This log has no records yet.'}
            </p>
          ) : (
            <div className={`tbl-wrap scroll-shade set-tbl set-tbl-scroll ${loading ? 'is-loading' : ''}`}>
              <table className="tbl as-cards set-audit">
                <thead>
                  <tr>
                    <th scope="col">When</th><th scope="col">Who</th><th scope="col">Outcome</th>
                    <th scope="col">Action</th><th scope="col">On</th><th scope="col">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map((e, i) => (
                    <tr key={`${e.at}-${i}`}>
                      <td className="set-nowrap"><When iso={e.at} /><span className="set-cell-sub">{LOGS.find((l) => l.id === e.log)?.label}</span></td>
                      <td className="set-wrap" data-label="Who">{e.who}</td>
                      <td data-label="Outcome"><span className={`set-outcome mono ${/REFUSED|FAILED|ERROR/.test(e.outcome) ? 'is-bad' : ''}`}>{e.outcome}</span></td>
                      <td className="mono" data-label="Action">{e.action}{e.kind && e.kind !== 'admin' && <span className="set-cell-sub">{e.kind}</span>}</td>
                      <td className="mono set-wrap" data-label="On">{e.target || <span className="dim">-</span>}</td>
                      <td className="set-wrap set-detail" data-label="Detail">{e.detail}{e.tookMs != null && <span className="set-cell-sub tnum">{e.tookMs} ms</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="set-pager">
            <span className="set-note tnum">
              {data.total === 0 ? '0 records' : `${data.offset + 1}-${Math.min(data.offset + data.limit, data.total)} of ${data.total}`}
              {data.skipped > 0 && ` · ${data.skipped} unreadable lines skipped`}
              {truncated.length > 0 && ` · only the newest 4 MB of ${truncated.join(', ')} is read`}
            </span>
            <Button variant="ghost" size="sm" disabled={data.offset === 0}
              onClick={() => set({ offset: Math.max(0, data.offset - PAGE) })}>Newer</Button>
            <Button variant="ghost" size="sm" disabled={data.offset + data.limit>= data.total}
              onClick={() => set({ offset: data.offset + PAGE })}>Older</Button>
          </div>
        </>
      )}
    </>
  );
}
