// ── the bottom panel ─────────────────────────────────────────────────────────
//
// Three tabs, and the third one is the reason there is no fourth.
//
//   Problems  every refusal, cap and advisory this page has met. Not a log -
//             a list of things that are true RIGHT NOW and that a reader would
//             otherwise have to infer from an absence (a tree that is short, a
//             folder that will not archive, a save that did not happen).
//   Output    what the page actually asked the service for, with the status and
//             the milliseconds. Written from the data layer's own emitter, not
//             from a hand-kept narrative beside it, because the two drift and
//             only the first one is evidence.
//   Git       recent commits across the open root, so the rail's per-file
//             history has a whole-repo counterpart.
//
// There is NO Terminal tab. There is no terminal capability behind this page and
// no plan for one; a permanently disabled tab is a promise the product does not
// keep, and it is worse than an absent tab because it invites the click.
//
// Collapsed by default - a diagnostics pane that is open before anything has
// gone wrong teaches people to ignore it.

import { AlertTriangle, ChevronDown, GitCommitVertical, Info, ScrollText, TriangleAlert, X } from 'lucide-react';
import { relDate, type ApiCall, type Commit } from '../../lib/files';

export type PanelTab = 'problems' | 'output' | 'git';

export interface Problem {
  id: string;
  tone: 'bad' | 'warn' | 'info';
  title: string;
  detail: string;
  where?: string;
}

function tone(c: ApiCall): string {
  if (c.status === 0) return 'bad';
  if (c.status === 401) return 'warn';
  return c.ok ? 'ok' : 'bad';
}

export function Panel({
  tab, setTab, problems, calls, commits, collapsed, onToggle, onClear,
}: {
  tab: PanelTab;
  setTab: (t: PanelTab) => void;
  problems: Problem[];
  calls: ApiCall[];
  commits: Commit[] | null;
  collapsed: boolean;
  onToggle: () => void;
  onClear: () => void;
}) {
  const badge = problems.filter((p) => p.tone === 'bad').length;

  const tabs: [PanelTab, string, number | null][] = [
    ['problems', 'Problems', problems.length],
    ['output', 'Output', calls.length],
    ['git', 'Git', commits ? commits.length : null],
  ];

  return (
    <section className={`fx-panel ${collapsed ? 'is-collapsed' : ''}`} aria-label="Panel">
      <div className="fx-panel-tabs" role="tablist" aria-label="Panel tabs">
        {tabs.map(([id, label, n]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`fx-tab-${id}`}
            aria-selected={!collapsed && tab === id}
            aria-controls="fx-panel-body"
            className={`fx-panel-tab ${!collapsed && tab === id ? 'on' : ''}`}
            onClick={() => { if (collapsed) onToggle(); setTab(id); }}
          >
            {label}
            {n !== null && n > 0 && (
              <span className={`fx-panel-badge ${id === 'problems' && badge ? 'bad' : ''}`}>{n}</span>
            )}
          </button>
        ))}
        <span className="fx-panel-spacer" />
        {!collapsed && tab === 'output' && calls.length > 0 && (
          <button type="button" className="fx-hbtn" onClick={onClear} aria-label="Clear the output log" title="Clear">
            <X size={14} />
          </button>
        )}
        <button
          type="button"
          className="fx-hbtn"
          onClick={onToggle}
          aria-label={collapsed ? 'Open the panel' : 'Close the panel'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Open the panel' : 'Close the panel'}
        >
          <ChevronDown size={15} className={collapsed ? 'fx-flip' : ''} />
        </button>
      </div>

      {!collapsed && (
        <div className="fx-panel-body scroll-shade" id="fx-panel-body" role="tabpanel" aria-labelledby={`fx-tab-${tab}`}>
          {tab === 'problems' && (
            problems.length === 0
              ? <p className="fx-panel-empty">Nothing to report. Refusals, caps and advisories land here.</p>
              : (
                <ul className="fx-problems">
                  {problems.map((p) => (
                    <li key={p.id} className={`fx-problem ${p.tone}`}>
                      {p.tone === 'bad' ? <AlertTriangle size={14} aria-hidden="true" />
                        : p.tone === 'warn' ? <TriangleAlert size={14} aria-hidden="true" />
                        : <Info size={14} aria-hidden="true" />}
                      <div className="fx-problem-body">
                        <div className="fx-problem-title">{p.title}</div>
                        <div className="fx-problem-detail">{p.detail}</div>
                      </div>
                      {p.where && <span className="fx-problem-where mono">{p.where}</span>}
                    </li>
                  ))}
                </ul>
              )
          )}

          {tab === 'output' && (
            calls.length === 0
              ? <p className="fx-panel-empty">No calls yet.</p>
              : (
                <ol className="fx-output">
                  {/* Newest first. A log read top-down is a log whose useful end
                      is the one you have to scroll to. */}
                  {calls.map((c) => (
                    <li key={c.id} className={`fx-call ${tone(c)}`}>
                      <span className="fx-call-time tnum">
                        {new Date(c.at).toLocaleTimeString(undefined, { hour12: false })}
                      </span>
                      <span className="fx-call-op mono">{c.op}</span>
                      <span className="fx-call-detail mono">{c.detail}</span>
                      <span className="fx-call-status tnum">{c.status || 'ERR'}</span>
                      <span className="fx-call-ms tnum">{c.ms >= 0 ? `${c.ms} ms` : ''}</span>
                      {c.note && <span className="fx-call-note">{c.note}</span>}
                    </li>
                  ))}
                </ol>
              )
          )}

          {tab === 'git' && (
            !commits
              ? <p className="fx-panel-empty"><ScrollText size={14} aria-hidden="true" /> Open a file to load its repository history.</p>
              : commits.length === 0
                ? <p className="fx-panel-empty">No commits here - this path is untracked, or outside a repo.</p>
                : (
                  <ol className="fx-gitlog">
                    {commits.map((c) => (
                      <li key={c.sha} className="fx-gitrow" title={new Date(c.date).toLocaleString()}>
                        <GitCommitVertical size={13} aria-hidden="true" />
                        <span className="fx-gitrow-sha mono">{c.sha.slice(0, 7)}</span>
                        <span className="fx-gitrow-subject">{c.subject}</span>
                        <span className="fx-gitrow-author">{c.author}</span>
                        <span className="fx-gitrow-when tnum">{relDate(c.date)}</span>
                      </li>
                    ))}
                  </ol>
                )
          )}
        </div>
      )}
    </section>
  );
}
