// Recent activity: the latest update jobs for anyone who may read updates, and
// for an operator the newest backups and the latest audit lines. Each block links
// to the Settings page that holds the whole record.
//
// The operator blocks are not drawn - and their sources never requested - for any
// other session (pages/control/home.ts gatesFor). A signed-out browser is offered
// the sign-in link instead of three refusals.

import { Link } from 'react-router-dom';
import { Activity } from 'lucide-react';
import type { UpdatesStatus, JobState } from '../../lib/updates';
import type { AuditResult, BackupsResult } from '../../lib/admin';
import { signInHref } from '../../lib/me';
import { fmtAge, type Gates } from '../../pages/control/home';
import type { Source } from './usePolled';
import { Card, SourceNote, ToneIcon, type Tone } from './parts';
import { Loader } from '../ui/Loader';

const JOB_TONE: Record<JobState, Tone> = {
  queued: 'unknown', running: 'unknown', succeeded: 'ok', rolled_back: 'warn', aborted: 'warn', failed: 'bad', refused: 'warn',
};
const ago = (iso: string | null | undefined, now: number) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? `${fmtAge((now - t) / 1000)} ago` : '-';
};

export function ActivityCard({
  gates, signedIn, updates, backups, audit, now,
}: {
  gates: Gates;
  signedIn: boolean;
  updates: Source<UpdatesStatus>;
  backups: Source<BackupsResult>;
  audit: Source<AuditResult>;
  now: number;
}) {
  if (!gates.updates) {
    return (
      <Card id="ch-act" title="Recent activity" icon={Activity}>
        <p className="ch-empty">
          {signedIn
            ? 'Update, backup and audit history need the viewer role or above.'
            : <>Update, backup and audit history are shown once you <a href={signInHref()}>sign in</a>.</>}
        </p>
      </Card>
    );
  }

  const u = updates.data;
  const jobs = [...(u?.job && !u.history?.some((h) => h.id === u.job!.id) ? [u.job] : []), ...(u?.history ?? [])].slice(0, 4);

  const sets = (backups.data?.sets ?? [])
    .filter((s) => s.managed && s.newest?.at)
    .sort((a, b) => Date.parse(b.newest!.at!) - Date.parse(a.newest!.at!))
    .slice(0, 4);

  return (
    <Card id="ch-act" title="Recent activity" icon={Activity}>
      <div className="ch-act">
        <div className="ch-act-block">
          <h3 className="ch-act-h"><Link to="/settings/updates">Update jobs</Link></h3>
          {!u ? <SourceNote state={updates.state} what="update history" /> : jobs.length === 0 ? (
            <p className="ch-empty">No update has run yet.</p>
          ) : (
            <ul className="ch-rows">
              {jobs.map((j) => (
                <li key={j.id}>
                  <Link className="ch-row" to="/settings/updates">
                    {/* A job the host is still running is in progress, not a
                        tone: the one Loader, silent - the row's words say it. */}
                    {j.state === 'running' || j.state === 'queued'
                      ? <Loader state="work" size="sm" label={j.state} labelHidden announce={false} />
                      : <ToneIcon tone={JOB_TONE[j.state]} label={j.state.replace('_', ' ')} />}
                    <span className="ch-row-name">{j.component}</span>
                    <span className="ch-row-mid ch-dim">{j.to?.version ?? j.state.replace('_', ' ')}{j.requestedBy === 'auto' ? ' · night job' : ''}</span>
                    <span className="ch-row-val">{ago(j.endedAt ?? j.startedAt ?? j.requestedAt, now)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        {gates.backups && (
          <div className="ch-act-block">
            <h3 className="ch-act-h"><Link to="/settings/backups">Backups</Link></h3>
            {!backups.data ? <SourceNote state={backups.state} what="the backup inventory" /> : sets.length === 0 ? (
              <p className="ch-empty">No managed backup has been written yet.</p>
            ) : (
              <ul className="ch-rows">
                {sets.map((s) => {
                  const age = (now - Date.parse(s.newest!.at!)) / 1000;
                  const old = age > 2 * 86_400;
                  return (
                    <li key={s.name}>
                      <Link className="ch-row" to="/settings/backups">
                        <ToneIcon tone={old ? 'warn' : 'ok'} label={old ? 'Stale' : 'Fresh'} />
                        <span className="ch-row-name mono">{s.name}</span>
                        <span className="ch-row-val">{fmtAge(age)} ago</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {gates.audit && (
          <div className="ch-act-block">
            <h3 className="ch-act-h"><Link to="/settings/audit">Audit log</Link></h3>
            {!audit.data ? <SourceNote state={audit.state} what="the audit log" /> : audit.data.entries.length === 0 ? (
              <p className="ch-empty">The audit log is empty.</p>
            ) : (
              <ul className="ch-rows">
                {audit.data.entries.slice(0, 5).map((a, i) => (
                  <li key={`${a.at}-${i}`}>
                    <Link className="ch-row" to="/settings/audit">
                      <span className="ch-row-name">{a.action}</span>
                      <span className="ch-row-mid ch-dim">{a.who} · {a.outcome.toLowerCase()}{a.target ? ` · ${a.target}` : ''}</span>
                      <span className="ch-row-val">{ago(a.at, now)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
