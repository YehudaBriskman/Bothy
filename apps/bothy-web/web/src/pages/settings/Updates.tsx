// Updates - what is newer than what this box runs, and (build step 4 of
// docs/plans/updates.md) the one-click deploy of what `main` already pins.
//
// Reads: GET /-/api/updates/status (viewer) - apps/bothy-ops/updates.toml merged
// with the file the host's discovery timer writes, the current job and the
// history. GET /-/api/updates/plan (viewer) - the plan the HOST pre-computed.
// GET /-/api/updates/job (viewer) - one job's steps.
//
// The one write: POST /-/api/updates/request (operator). The browser sends the
// PLAN ID the host wrote, never a version: the updater deploys only what the
// checked-out `main` already pins (Dependabot PR merged -> pull -> one click), and
// re-derives the plan on the host before it acts. There is no version picker on
// this page because there is nothing for a picker to choose.
//
// THE UPDATE BUTTON IS A COURTESY. It is drawn for operators (lib/session.ts); the
// decision is the edge's `sso-operator` gate and the host's re-validation.
//
// Step 7, the automatic channel: a night job on the host (03:30) deploys at most
// one `auto` patch a night and writes its records as the actor `auto` - shown here
// as "the night job". A rollback or a failure PAUSES auto for that component; the
// pause is the host's (auto.json, read-only to bothy-ops), so Unpause (operator,
// POST /-/api/updates/unpause) only asks, and the row says "waiting for the host"
// until the host has cleared it.
//
// The job panel follows a job by id, remembered in localStorage: the update it is
// watching may recreate bothy-ops or bothy-web underneath it, so a failed poll is
// "reconnecting", never an end state. Only the host says a job is over.
//
// Colour: a level badge is NOT state, so it is drawn in the neutral chrome. Drift,
// a failed check and a job's outcome ARE state and take the reserved palette,
// always with a glyph and a word beside it.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, ArrowUpRight, Check, CircleDashed, CirclePause, Lock, Minus, RotateCcw, X,
} from 'lucide-react';
import { filesHref } from '../files/routes';
import { SettingBlock } from '../../components/settings/SettingBlock';
import { Cmd, Loading, Prose, Refusal, When, fmtBytes, useLoad } from '../../components/settings/bits';
import { Dialog } from '../../components/ui/Dialog';
import '../../components/ServiceActions.css';
import '../../components/KubeActions.css';
import { useOperator } from '../../lib/session';
import { statusOf } from '../../lib/http';
import {
  AUTO_ACTOR, fetchJob, fetchPlan, fetchUpdates, isTerminal, pinFile, publishBehind, rememberJob, rememberedJob,
  requestUpdate, unpauseAuto,
  type Channel, type HistoryEntry, type Job, type JobState, type JobStep, type Level, type OwnPlan, type Plan, type UpdateRow,
  type UpdatesStatus, type UpdaterInfo,
} from '../../lib/updates';
import { Button } from '../../components/ui/Button';

export function UpdatesSettings() {
  const { data, error, loading, reload } = useLoad((signal) => fetchUpdates(signal));
  const { canAct } = useOperator();
  const [planFor, setPlanFor] = useState<UpdateRow | null>(null);
  // The job this tab follows: one it asked for (remembered across reloads), else
  // whatever the host says is running now.
  const [followed, setFollowed] = useState<string | null>(() => rememberedJob());
  const hostJob = data?.job && !isTerminal(data.job.state) ? data.job.id : null;
  const jobId = followed ?? hostJob;

  // The page's own read is the freshest count there is; hand it to the nav.
  useEffect(() => { if (data) publishBehind(data.summary.behind); }, [data]);

  const started = (id: string) => {
    rememberJob(id);
    setFollowed(id);
    setPlanFor(null);
    reload();
  };
  const dismiss = () => { rememberJob(null); setFollowed(null); };

  const fail = (
    <>
      <Refusal error={error} needs="viewer" what="update checks" />
      <Button variant="ghost" size="sm" onClick={reload}>Retry</Button>
    </>
  );
  return (
    <>
      {data && <Freshness d={data} />}
      {data?.updater?.staged && <UpdaterStaged u={data.updater} />}
      {jobId && <JobPanel id={jobId} key={jobId} onFinished={reload} onDismiss={dismiss} />}
      <SettingBlock id="update-components" badge="viewer · update: operator">
        {loading && !data ? <Loading rows={8} /> : error ? fail : data && (
          <Components d={data} canAct={canAct} busy={!!jobId && !!data.applying} onUpdate={setPlanFor} onChanged={reload} />
        )}
      </SettingBlock>
      <SettingBlock id="update-apply" badge="host updater">
        <Apply d={data} />
      </SettingBlock>
      <SettingBlock id="update-history" badge="history.jsonl">
        {loading && !data ? <Loading rows={3} /> : <History d={data} />}
      </SettingBlock>
      <SettingBlock id="update-channels" badge="from updates.toml">
        {loading && !data ? <Loading rows={3} /> : <Channels d={data} />}
      </SettingBlock>
      {planFor && <PlanDialog row={planFor} onClose={() => setPlanFor(null)} onStarted={started} />}
    </>
  );
}

function Freshness({ d }: { d: UpdatesStatus }) {
  const s = d.summary;
  if (!d.discovery.present) {
    return (
      <p className="set-fresh is-stale" role="status">
        <AlertTriangle size={14} aria-hidden="true" />
        <span><Prose text={d.discovery.hint ?? 'Nothing discovered yet - run `just updates-discover` on the host.'} /></span>
      </p>
    );
  }
  const ready = d.components.filter((r) => r.plan?.deployable).length;
  const paused = d.components.filter((r) => r.paused).length;
  return (
    <p className={`set-fresh ${d.discovery.stale ? 'is-stale' : ''}`} role="status">
      {d.discovery.stale && <AlertTriangle size={14} aria-hidden="true" />}
      <span>
        {s.components} components · {s.updates} with a newer version · <b>{s.behind}</b> a minor or more behind
        {s.drift > 0 && <> · {s.drift} drifting</>}
        {s.errors > 0 && <> · {s.errors} not checked</>}
        {ready > 0 && <> · <b>{ready}</b> ready to deploy</>}
        {paused > 0 && <> · <span className="set-warn">{paused} automatic {paused === 1 ? 'update' : 'updates'} paused</span></>}.
        {' '}Checked on the host <When iso={d.discovery.generatedAt} />
        {d.discovery.stale
          ? ` - older than two ${d.policy.discoverEveryHours}-hour runs; the bothy-updates-discover timer may not be running.`
          : '.'}
      </span>
    </p>
  );
}

// A Bothy update that changed the updater itself left its new copy STAGED: the
// host updater never replaces itself in the middle of a run, so switching is a
// person's step, between jobs.
function UpdaterStaged({ u }: { u: UpdaterInfo }) {
  return (
    <p className="set-fresh is-stale upd-staged" role="status">
      <AlertTriangle size={14} aria-hidden="true" />
      <span>
        A new updater is staged (<span className="mono">{u.staged!.slice(0, 12)}</span>, <When iso={u.stagedAt} />) beside the
        one that runs (<span className="mono">{u.current ? u.current.slice(0, 12) : 'none'}</span>). Bothy was updated; the
        program that updates it switches only when you say so: <Cmd>just install-updater</Cmd> on the host.
      </span>
    </p>
  );
}

// ── the table ────────────────────────────────────────────────────────────────

const GROUP_TITLE: Record<Channel, string> = {
  auto: 'Automatic - patch releases only, in the night window',
  notify: 'Notify - shown here, applied by a person',
  manual: 'Manual only - the auth boundary, the databases and one-way migrations',
};

const LEVEL_WORD: Record<Level, string> = { patch: 'patch', minor: 'minor', major: 'major' };

function LevelBadge({ level }: { level: Level }) {
  return <span className="upd-level" data-level={level}>{LEVEL_WORD[level]}</span>;
}

interface RowCtx { canAct: boolean; busy: boolean; onUpdate: (r: UpdateRow) => void; onChanged: () => void }

function Components({ d, ...ctx }: { d: UpdatesStatus } & RowCtx) {
  const groups = (['auto', 'notify', 'manual'] as Channel[])
    .map((ch) => ({ ch, rows: d.components.filter((r) => r.channel === ch) }))
    .filter((g) => g.rows.length > 0);
  return (
    <>
      <div className="tbl-wrap set-tbl">
        <table className="tbl upd-tbl">
          <thead>
            <tr>
              <th scope="col">Component</th>
              <th scope="col">Pinned</th>
              <th scope="col">Running</th>
              <th scope="col">Available</th>
              <th scope="col">Channel</th>
              <th scope="col">Notes</th>
              <th scope="col">Deploy</th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.ch}>
              <tr className="set-tbl-sep"><td colSpan={7}>{GROUP_TITLE[g.ch]}</td></tr>
              {g.rows.map((r) => <Row key={r.id} r={r} {...ctx} />)}
            </tbody>
          ))}
        </table>
      </div>
      <p className="set-note set-tbl-note">
        <b>Deploy</b> runs what the checkout’s <span className="mono">main</span> already pins - a merged pin that is not
        running yet. <b>Available</b> is what is newer upstream; to get it, merge its Dependabot PR first. <b>Drift</b> means
        what runs is not what the repository pins. A <b>floating</b> pin (<span className="mono">v3.7</span>,{' '}
        <span className="mono">17</span>) can move under you and is never deployed by the updater.
      </p>
    </>
  );
}

function Row({ r, canAct, busy, onUpdate, onChanged }: { r: UpdateRow } & RowCtx) {
  const d = r.discovered;
  return (
    <tr>
      <td className="upd-name">
        <b>{r.title}</b>
        <span className="set-cell-sub mono">{r.id} · {r.class}</span>
      </td>
      {/* data-label: below 640px the table becomes one card per component, and
          a cell names itself because the header row is no longer beside it. */}
      <td data-label="Pinned"><Pinned r={r} /></td>
      <td data-label="Running"><Running r={r} /></td>
      <td data-label="Available"><Available r={r} /></td>
      <td data-label="Channel"><ChannelCell r={r} canAct={canAct} onChanged={onChanged} /></td>
      <td data-label="Notes" className="upd-notes">
        {r.oneWay && (
          <span className="upd-oneway" title={r.oneWayWhy ?? undefined}>
            <Lock size={12} aria-hidden="true" />one-way
          </span>
        )}
        <a className="link upd-cl" href={r.changelog} target="_blank" rel="noreferrer noopener">
          Changelog<ArrowUpRight size={12} aria-hidden="true" />
        </a>
        <span className="set-cell-sub">{d?.checkedAt ? <>checked <When iso={d.checkedAt} /></> : 'not checked yet'}</span>
      </td>
      <td data-label="Deploy" className="upd-deploy"><DeployCell r={r} canAct={canAct} busy={busy} onUpdate={onUpdate} /></td>
    </tr>
  );
}

function DeployCell({ r, canAct, busy, onUpdate }: { r: UpdateRow } & Omit<RowCtx, 'onChanged'>) {
  const p = r.plan;
  if (!p) return <span className="dim">no plan</span>;
  if (!p.deployable) return <span className="set-cell-sub upd-reason" title={p.reason.replace(/`/g, '')}><Ticks text={p.reason} /></span>;
  return (
    <>
      <span className="upd-avail">
        <span className="mono upd-tag">{p.from} → {p.to}</span>
        <LevelBadge level={p.level} />
      </span>
      {canAct ? (
        <Button size="sm" className="upd-go" onClick={() => onUpdate(r)} disabled={busy}
          title={busy ? 'An update is running - one at a time' : undefined}>
          Update…
        </Button>
      ) : (
        <span className="set-cell-sub">needs <span className="mono">operator</span></span>
      )}
    </>
  );
}

function Pinned({ r }: { r: UpdateRow }) {
  const c = r.discovered?.current;
  const where = pinFile(r.pins[0]);
  if (!c) return <><span className="dim">-</span><span className="set-cell-sub mono">{where}</span></>;
  return (
    <>
      <span className="mono upd-tag">{c.tag ?? c.identifiedAs ?? c.version ?? 'a digest'}</span>
      <span className="set-cell-sub">
        {c.float ? `floating${c.floatTarget ? `, now ${c.floatTarget}` : ''} · ` : !c.tag ? 'by digest · ' : ''}
        <span className="mono">{where}</span>
        {r.pins.length > 1 && ` +${r.pins.length - 1}`}
      </span>
    </>
  );
}

const tagOf = (image: string | null): string | null => {
  if (!image) return null;
  const at = image.indexOf('@');
  if (at >= 0) return null;
  const last = image.split('/').pop() ?? '';
  return last.includes(':') ? last.split(':').pop() ?? null : null;
};

function Running({ r }: { r: UpdateRow }) {
  const d = r.discovered;
  if (!d) return <span className="dim">-</span>;
  const run = d.running[0];
  const shown = d.runningVersion ?? tagOf(run?.image ?? null) ?? (run ? 'pinned digest' : null);
  return (
    <>
      {shown ? <span className="mono upd-tag">{shown}</span> : (
        <span className="dim">{r.source === 'github' ? 'this checkout' : r.class === 'cluster' ? 'cluster not reached' : 'not running'}</span>
      )}
      {d.drift && (
        <span className="upd-drift set-warn" title={d.drift}>
          <AlertTriangle size={12} aria-hidden="true" />drift
        </span>
      )}
      {d.notes.map((n) => <span key={n} className="set-cell-sub">{n}</span>)}
    </>
  );
}

function Available({ r }: { r: UpdateRow }) {
  const d = r.discovered;
  if (!d) return <span className="dim">not checked yet</span>;
  if (d.error) {
    return (
      <>
        <span className="set-warn upd-err"><AlertTriangle size={12} aria-hidden="true" />not checked</span>
        <span className="set-cell-sub upd-why" title={d.error}>{d.error}</span>
      </>
    );
  }
  if (!d.latest || !d.latest.level) {
    return <span className="upd-current"><Check size={13} aria-hidden="true" />up to date</span>;
  }
  const moved = !!d.latest.floating;
  const others = (['patch', 'minor', 'major'] as Level[])
    .map((lv) => d.candidates[lv])
    .filter((c) => c && c.tag !== d.latest!.tag);
  return (
    <>
      <span className="upd-avail">
        <span className="mono upd-tag">{moved ? `${d.latest.tag} → ${d.latest.version ?? 'newer'}` : d.latest.tag}</span>
        <LevelBadge level={d.latest.level} />
      </span>
      {others.length > 0 && (
        <span className="set-cell-sub">
          also {others.map((c, i) => (
            <span key={c!.tag}>{i > 0 && ', '}<span className="mono">{c!.tag}</span> ({c!.level})</span>
          ))}
        </span>
      )}
      {moved && <span className="set-cell-sub">the tag moved to a newer image</span>}
      {d.latest.publishedAt && <span className="set-cell-sub">released <When iso={d.latest.publishedAt} /></span>}
    </>
  );
}

const CHANNEL_WORD: Record<Channel, string> = { auto: 'auto', notify: 'notify', manual: 'manual' };

function ChannelCell({ r, canAct, onChanged }: { r: UpdateRow; canAct: boolean; onChanged: () => void }) {
  const eff = r.effectiveChannel;
  return (
    <>
      <span className="upd-channel" data-channel={eff ?? r.channel}>{CHANNEL_WORD[eff ?? r.channel]}</span>
      {eff && eff !== r.channel && (
        <span className="set-cell-sub">
          {r.channel} component; {r.level === 'major' ? 'a major is always manual' : 'only its patches are automatic'}
        </span>
      )}
      {r.paused && <Paused r={r} canAct={canAct} onChanged={onChanged} />}
    </>
  );
}

// ── a paused automatic channel, and the operator's Unpause ──────────────────

function Paused({ r, canAct, onChanged }: { r: UpdateRow; canAct: boolean; onChanged: () => void }) {
  const p = r.paused!;
  const [phase, setPhase] = useState<{ t: 'idle' } | { t: 'sending' } | { t: 'asked' } | { t: 'refused'; error: unknown }>({ t: 'idle' });
  const waiting = r.unpauseQueued || phase.t === 'asked';
  // The host clears the pause a moment after the spool file lands; look again
  // until the row says so, rather than claiming it here.
  useEffect(() => {
    if (!waiting) return undefined;
    const t = setTimeout(onChanged, 3000);
    return () => clearTimeout(t);
  }, [waiting, onChanged, r.unpauseQueued]);
  const go = async () => {
    setPhase({ t: 'sending' });
    try {
      await unpauseAuto(r.id);
      setPhase({ t: 'asked' });
      onChanged();
    } catch (e) {
      setPhase({ t: 'refused', error: e });
    }
  };
  return (
    <span className="upd-paused">
      <span className="set-warn upd-paused-h" title={p.reason.replace(/`/g, '')}>
        <CirclePause size={12} aria-hidden="true" />auto paused
      </span>
      <span className="set-cell-sub upd-why">
        <Ticks text={p.reason} />
        {p.since && <> · since <When iso={p.since} /></>}
        {p.requestedBy && <> · job asked by <Actor who={p.requestedBy} /></>}
      </span>
      {waiting ? (
        <span className="set-cell-sub" role="status"><span className="sa-spin" aria-hidden="true" /> unpause asked - waiting for the host</span>
      ) : canAct ? (
        <Button variant="ghost" size="sm" className="upd-unpause" onClick={() => void go()} disabled={phase.t === 'sending'}
          title="Let the night job update this component again. Find out why it failed first.">
          {phase.t === 'sending' ? 'Asking the host…' : 'Unpause'}
        </Button>
      ) : (
        <span className="set-cell-sub">unpause needs <span className="mono">operator</span></span>
      )}
      {phase.t === 'refused' && <PlanRefusal error={phase.error} />}
    </span>
  );
}

/** Who asked: a person's name, or the night job for the system actor. */
function Actor({ who }: { who: string }) {
  if (who !== AUTO_ACTOR) return <>{who}</>;
  return <span className="upd-actor-auto" title={`requestedBy "${AUTO_ACTOR}": bothy-updater-auto.timer, in the night window`}>the night job</span>;
}

// ── the plan view ────────────────────────────────────────────────────────────

/** Backticked spans as inline code - for prose that NAMES a command (a plan fact,
 *  a step's detail) rather than hands one over. <Prose> makes each one copyable,
 *  which is right for "run this next" and noise in a list of facts. */
function Ticks({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/g).map((t, i) => (t.startsWith('`') && t.endsWith('`') && t.length > 2
        ? <code key={i} className="mono upd-code">{t.slice(1, -1)}</code>
        : <span key={i}>{t}</span>))}
    </>
  );
}

const shortDigest = (d: string | null) => (d ? `${d.slice(0, 19)}…` : 'digest unknown');

function PlanDialog({ row, onClose, onStarted }: { row: UpdateRow; onClose: () => void; onStarted: (jobId: string) => void }) {
  const { data, error, loading } = useLoad((signal) => fetchPlan(row.id, signal), [row.id]);
  const [typed, setTyped] = useState('');
  const [note, setNote] = useState('');
  const [phase, setPhase] = useState<{ t: 'idle' } | { t: 'sending' } | { t: 'refused'; error: unknown }>({ t: 'idle' });
  const firing = useRef(false);
  const plan = data?.plan ?? null;
  const noteOk = !plan?.requiresNote || (note.trim().length >= 10 && note.trim().length <= 500);
  const ready = !!plan && (plan.confirm === 'click' || typed === plan.component) && noteOk && phase.t !== 'sending';

  const go = async () => {
    if (!plan || !ready || firing.current) return;
    firing.current = true;
    setPhase({ t: 'sending' });
    try {
      const r = await requestUpdate({ component: plan.component, plan_id: plan.id, confirm: plan.confirm === 'click' ? true : typed,
        ...(plan.requiresNote ? { note: note.trim() } : {}) });
      onStarted(r.jobId);
    } catch (e) {
      setPhase({ t: 'refused', error: e });
    } finally {
      firing.current = false;
    }
  };

  return (
    <Dialog
      open size="lg"
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={<span className="sa-title">Update <span className="mono">{row.title}</span></span>}
      description="The plan the host wrote. Approving it approves this plan id - the host re-derives it and refuses one that is no longer current."
    >
      <div className="ka-body upd-plan">
        {loading ? <p className="sa-working" role="status"><span className="sa-spin" />Reading the plan…</p>
          : error ? <PlanRefusal error={error} />
            : !plan ? (
              <div className="sa-norole">
                <p className="sa-norole-h">No update to deploy.</p>
                <p className="sa-note"><Prose text={data?.reason ?? 'The host wrote no plan for this component.'} /></p>
              </div>
            ) : (
              <>
                <PlanFacts plan={plan} age={data?.ageSeconds ?? null} />
                {phase.t === 'refused' && <PlanRefusal error={phase.error} />}
                <form className="ka-confirm" onSubmit={(e) => { e.preventDefault(); void go(); }}>
                  <p className="sa-warn">
                    <AlertTriangle size={16} aria-hidden="true" />
                    <span>
                      This recreates {plan.restarts.length > 0 ? plan.restarts.join(', ') : plan.component} on the host.
                      {' '}Signed out: {plan.signedOut}.
                    </span>
                  </p>
                  {plan.requiresNote && (
                    <label className="ka-field">
                      <span className="ka-label">Maintenance note - what, why, and who is told (10-500 characters, one line)</span>
                      <input
                        className="ka-input" autoComplete="off" value={note} maxLength={500}
                        onChange={(e) => setNote(e.target.value.replace(/[\r\n]+/g, ' '))}
                        aria-invalid={note.length > 0 && !noteOk}
                      />
                    </label>
                  )}
                  {plan.confirm === 'type-name' && (
                    <label className="ka-field">
                      <span className="ka-label">Type <span className="mono">{plan.component}</span> to confirm</span>
                      <input
                        className="ka-input mono" autoComplete="off" spellCheck={false} value={typed}
                        onChange={(e) => setTyped(e.target.value)} aria-invalid={typed.length > 0 && typed !== plan.component}
                      />
                    </label>
                  )}
                  <div className="ka-row">
                    <Button variant="ghost" onClick={onClose}>Leave it alone</Button>
                    <Button variant="caution" type="submit" disabled={!ready}>
                      {phase.t === 'sending' ? 'Asking the host…' : `Update ${plan.component} to ${plan.to.tag ?? plan.to.version ?? 'the pin'}`}
                    </Button>
                  </div>
                </form>
              </>
            )}
      </div>
    </Dialog>
  );
}

function PlanRefusal({ error }: { error: unknown }) {
  const status = statusOf(error);
  const msg = error instanceof Error ? error.message : String(error);
  const fromService = !!(error as { fromService?: boolean } | null)?.fromService;
  const title = status === 409 ? 'The host would not queue it.'
    : status === 403 && !fromService ? 'Your session does not hold operator.'
      : status === 401 ? 'Sign in first.'
        : status === 0 ? 'Nothing answered.' : `Refused (${status}).`;
  return (
    <div className="sa-outcome" data-ok="false" role="alert">
      <p className="sa-outcome-h">{title}</p>
      {fromService && <p className="sa-note"><Prose text={msg} /></p>}
    </div>
  );
}

function PlanFacts({ plan, age }: { plan: Plan; age: number | null }) {
  if (plan.own) return <OwnFacts plan={plan} own={plan.own} age={age} />;
  return (
    <div className="upd-plan-facts">
      <div className="upd-diff" aria-label="pin change">
        <div className="upd-diff-side">
          <span className="upd-diff-k">running</span>
          <span className="mono upd-tag">{plan.from.image}</span>
          <span className="mono set-cell-sub">{shortDigest(plan.from.digest)}</span>
        </div>
        <ArrowRight size={16} aria-hidden="true" className="upd-diff-arrow" />
        <div className="upd-diff-side">
          <span className="upd-diff-k">main pins</span>
          <span className="mono upd-tag">{plan.to.image}</span>
          <span className="mono set-cell-sub">{shortDigest(plan.to.digest)}</span>
        </div>
        <LevelBadge level={plan.level} />
      </div>
      <dl className="upd-dl">
        <dt>{(plan.pins?.length ?? 1) > 1 ? 'Pins' : 'Pin'}</dt>
        {(plan.pins?.length ?? 1) > 1
          ? <dd>{plan.pins!.map((q, i) => <span key={`${q.file}:${q.service}`}>{i > 0 && ', '}
              <span className="mono">{q.file}:{q.line ?? '?'}</span> (<span className="mono">{q.service}</span>)</span>)}
              {' '}at <span className="mono">{plan.pin.commit.slice(0, 10)}</span> - one image, every line; a rollback puts all of them back.</dd>
          : <dd><span className="mono">{plan.pin.file}:{plan.pin.line}</span> (service <span className="mono">{plan.pin.service}</span>) at{' '}
              <span className="mono">{plan.pin.commit.slice(0, 10)}</span> - the checkout already says this; nothing is edited.</dd>}
        <dt>Changelog</dt>
        <dd>{plan.changelog
          ? <a className="link upd-cl" href={plan.changelog} target="_blank" rel="noreferrer noopener">{plan.to.version ?? plan.to.tag}<ArrowUpRight size={12} aria-hidden="true" /></a>
          : <span className="dim">none linked</span>}</dd>
        <dt>Restarts</dt>
        <dd>{plan.restarts.join(', ')} · via <span className="mono">{plan.recipe}</span></dd>
        <dt>Downtime</dt>
        <dd>{plan.downtime}</dd>
        <dt>Signed out</dt>
        <dd>{plan.signedOut}</dd>
        <dt>Snapshot</dt>
        <dd><Ticks text={plan.snapshot.what} /> <span className="set-cell-sub">
          into <span className="mono">{plan.snapshot.dir}</span>
          {plan.snapshot.estimateBytes != null && <> · about {fmtBytes(plan.snapshot.estimateBytes)}</>} · the last 3 are kept</span></dd>
        {plan.oneWay && <><dt>One-way</dt><dd className="set-warn"><Lock size={12} aria-hidden="true" />{plan.oneWayWhy}</dd></>}
        {plan.cluster && <><dt>Cluster</dt>
          <dd>context <span className="mono">{plan.cluster.context}</span> as <span className="mono">{plan.cluster.identity}</span>
            {plan.cluster.revision != null && <> · helm revision {plan.cluster.revision} is the rollback point</>}
            {' '}· only <span className="mono">{plan.recipe}</span></dd></>}
        {plan.pgMajor && <><dt>Volumes</dt>
          <dd><span className="mono">{plan.pgMajor.oldVolume}</span> ({plan.pgMajor.fromMajor}) <ArrowRight size={12} aria-hidden="true" />{' '}
            <span className="mono">{plan.pgMajor.newVolume}</span> ({plan.pgMajor.toMajor}). The old volume is never deleted by this;
            later, by hand: <span className="mono">{plan.pgMajor.deleteOld}</span></dd></>}
        {(plan.procedure?.length ?? 0) > 0 && <><dt>Procedure</dt>
          <dd><ol className="upd-list">{plan.procedure!.map((x) => <li key={x}><Ticks text={x} /></li>)}</ol></dd></>}
        <dt>Pre-flight</dt>
        <dd><ul className="upd-list">{plan.preflight.map((x) => <li key={x}><Ticks text={x} /></li>)}</ul></dd>
        <dt>Verify</dt>
        <dd><ul className="upd-list">{plan.verify.map((x) => <li key={x}><Ticks text={x} /></li>)}</ul></dd>
        <dt>Rollback</dt>
        <dd><Ticks text={plan.rollback} /></dd>
        <dt>Plan</dt>
        <dd><span className="mono">{plan.id}</span> · written <When iso={plan.createdAt} />
          {age != null && age > 12 * 3600 && <span className="set-warn"> · over 12 h old - `just updates-discover` refreshes it</span>}</dd>
      </dl>
    </div>
  );
}

// Bothy itself (class own-code, step 6): not a pin but a release tag, built before
// anything changes and rolled back by a timer.
function OwnFacts({ plan, own, age }: { plan: Plan; own: OwnPlan; age: number | null }) {
  const sha = (s: string | null) => (s ? s.slice(0, 12) : '?');
  const files = (xs: string[], more?: number | null) => (
    <>
      {xs.map((f, i) => <span key={f}>{i > 0 && ', '}<span className="mono">{f}</span></span>)}
      {more != null && more > xs.length && <span className="set-cell-sub"> and {more - xs.length} more</span>}
    </>
  );
  const mins = own.rollbackAfter ? Math.round(own.rollbackAfter / 60) : 10;
  return (
    <div className="upd-plan-facts">
      <div className="upd-diff" aria-label="release change">
        <div className="upd-diff-side">
          <span className="upd-diff-k">running</span>
          <span className="mono upd-tag">{plan.from.tag ?? plan.from.version}</span>
          <span className="mono set-cell-sub">{sha(own.fromSha)}</span>
        </div>
        <ArrowRight size={16} aria-hidden="true" className="upd-diff-arrow" />
        <div className="upd-diff-side">
          <span className="upd-diff-k">green release</span>
          <span className="mono upd-tag">{own.tag ?? plan.to.tag}</span>
          <span className="mono set-cell-sub">{sha(own.toSha)}</span>
        </div>
        <LevelBadge level={plan.level} />
      </div>
      <dl className="upd-dl">
        <dt>Release</dt>
        <dd>{own.releaseUrl
          ? <a className="link upd-cl" href={own.releaseUrl} target="_blank" rel="noreferrer noopener">{own.tag} release notes<ArrowUpRight size={12} aria-hidden="true" /></a>
          : <span className="dim">none linked</span>}
          {own.commits != null && <span className="set-cell-sub">{own.commits} commits{own.diffstat ? ` · ${own.diffstat}` : ''}</span>}</dd>
        <dt>CI</dt>
        <dd><span className="upd-ci"><Check size={13} aria-hidden="true" />{own.ci.detail ?? 'verified green'}</span>
          <span className="set-cell-sub">asked via {own.ci.via ?? 'the GitHub API'}; release.yml tags only commits whose CI passed on main</span></dd>
        <dt>Rebuilds</dt>
        <dd>{own.apps.length ? files(own.apps) : <span className="dim">no app source changed</span>}
          <span className="set-cell-sub">built from a temporary worktree of {own.tag} <b>before</b> anything running changes;
            then {(own.order.length ? own.order : plan.restarts).join(', then ')} come up - web last</span></dd>
        {own.compose.length > 0 && <><dt>Compose</dt><dd>{files(own.compose)} <span className="set-cell-sub">applied by <span className="mono">{plan.recipe}</span></span></dd></>}
        {own.edge.length > 0 && <><dt>Edge</dt><dd>{files(own.edge)} <span className="set-cell-sub">Traefik reloads these the moment the checkout moves</span></dd></>}
        {own.elsewhere.length > 0 && (
          <><dt>Not applied</dt><dd>{files(own.elsewhere, own.elsewhereCount)}
            <span className="set-cell-sub">other stacks’ files: in the checkout afterwards, applied by their own rows or recipes, not by this update</span></dd></>
        )}
        {own.updater && (
          <><dt>Updater</dt><dd className="set-warn upd-own-updater"><AlertTriangle size={12} aria-hidden="true" />
            <span>this release changes the updater ({files(own.updaterFiles)}): its new copy is <b>staged</b>, not switched -
              {' '}<span className="mono">just install-updater</span> afterwards</span></dd></>
        )}
        <dt>Downtime</dt>
        <dd>{plan.downtime}</dd>
        <dt>Signed out</dt>
        <dd>{plan.signedOut}</dd>
        <dt>Snapshot</dt>
        <dd>{plan.snapshot.what} <span className="set-cell-sub">into <span className="mono">{plan.snapshot.dir}</span></span></dd>
        <dt>Pre-flight</dt>
        <dd><ul className="upd-list">{plan.preflight.map((x) => <li key={x}><Ticks text={x} /></li>)}</ul></dd>
        <dt>Verify</dt>
        <dd><ul className="upd-list">{plan.verify.map((x) => <li key={x}><Ticks text={x} /></li>)}</ul></dd>
        <dt>Rollback</dt>
        <dd><Ticks text={plan.rollback} /> <span className="set-cell-sub">Timer: {mins} min.</span></dd>
        <dt>Plan</dt>
        <dd><span className="mono">{plan.id}</span> · written <When iso={plan.createdAt} />
          {age != null && age > 12 * 3600 && <span className="set-warn"> · over 12 h old - `just updates-discover` refreshes it</span>}</dd>
      </dl>
    </div>
  );
}

// ── the live job ─────────────────────────────────────────────────────────────

const STATE_WORD: Record<JobState, string> = {
  queued: 'Queued - waiting for the host',
  running: 'Running on the host',
  succeeded: 'Updated',
  rolled_back: 'Rolled back',
  aborted: 'Aborted - nothing running was changed',
  failed: 'Failed - a person is needed',
  refused: 'Refused - nothing was touched',
};

// What a state means in the reserved palette: good, a warning, or down.
const STATE_TONE: Record<JobState, 'up' | 'warn' | 'down' | 'busy'> = {
  queued: 'busy', running: 'busy', succeeded: 'up', rolled_back: 'warn', aborted: 'warn', refused: 'warn', failed: 'down',
};

const STEP_WORD: Record<JobStep['name'], string> = {
  validate: 'Re-validate the request and the plan',
  preflight: 'Pre-flight',
  snapshot: 'Snapshot',
  pull: 'Pull the image',
  apply: 'Apply',
  verify: 'Verify (canaries)',
  rollback: 'Roll back',
  restore: 'Restore the data snapshot',
  record: 'Record',
  build: 'Build the new images (nothing running is touched)',
  arm: 'Arm the rollback timer',
  switch: 'Move the checkout (fast-forward)',
  stage: 'Stage the new updater (not switched)',
  // The Postgres major (step 8). `switch` there is compose moving to the new volume.
  stop: 'Stop the writers (Keycloak, oauth2-proxy, the exporter)',
  dump: 'pg_dumpall, rows counted from the dump',
  create: 'Create the new volume and a temporary Postgres on it',
  load: 'Restore the dump into it',
  compare: 'Compare every database and row count with the dump',
  start: 'Start Keycloak and oauth2-proxy again',
};

function useJob(id: string) {
  const [job, setJob] = useState<Job | null>(null);
  const [lost, setLost] = useState<{ since: number; why: string } | null>(null);
  const [gone, setGone] = useState(false);
  const stop = useRef(false);

  const poll = useCallback(async (signal: AbortSignal) => {
    try {
      const j = await fetchJob(id, signal);
      setJob(j);
      setLost(null);
      if (isTerminal(j.state)) stop.current = true;
    } catch (e) {
      if (signal.aborted) return;
      const s = statusOf(e);
      // A 404 from the SERVICE is an answer: the host has no such job. Anything
      // else - a network error, a 502 from Traefik while bothy-ops is recreated,
      // the portal's HTML while bothy-web is - is the update happening, not an end.
      if (s === 404 && (e as { fromService?: boolean }).fromService) { setGone(true); stop.current = true; return; }
      setLost((l) => l ?? { since: Date.now(), why: s === 0 ? 'nothing answered' : `answered ${s}` });
    }
  }, [id]);

  useEffect(() => {
    stop.current = false;
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await poll(ac.signal);
      if (!stop.current && !ac.signal.aborted) timer = setTimeout(() => void tick(), 2000);
    };
    void tick();
    return () => { ac.abort(); if (timer) clearTimeout(timer); };
  }, [poll]);

  return { job, lost, gone };
}

function JobPanel({ id, onFinished, onDismiss }: { id: string; onFinished: () => void; onDismiss: () => void }) {
  const { job, lost, gone } = useJob(id);
  const ref = useRef<HTMLElement>(null);
  const done = !!job && isTerminal(job.state);
  const finished = useRef(false);
  useEffect(() => {
    if (done && !finished.current) { finished.current = true; onFinished(); }
  }, [done, onFinished]);
  useEffect(() => { ref.current?.scrollIntoView?.({ block: 'nearest' }); }, []);

  if (gone) {
    return (
      <section className="upd-job" data-tone="warn" aria-label="Update job">
        <p className="upd-job-h"><AlertTriangle size={15} aria-hidden="true" />The host has no job <span className="mono">{id.slice(0, 12)}</span>.</p>
        <div className="ka-row"><Button variant="ghost" size="sm" onClick={onDismiss}>Dismiss</Button></div>
      </section>
    );
  }
  const tone = job ? STATE_TONE[job.state] : 'busy';
  return (
    <section ref={ref} className="upd-job" data-tone={tone} aria-label="Update job" aria-live="polite">
      <header className="upd-job-head">
        <p className="upd-job-h">
          {!job || !done ? <span className="sa-spin" aria-hidden="true" /> : <JobGlyph state={job.state} />}
          <span>{job ? STATE_WORD[job.state] : 'Asking the host…'}</span>
          {job && <span className="mono upd-job-what">{job.component}{job.to ? ` → ${job.to.version ?? job.to.image}` : ''}</span>}
        </p>
        {done && <Button variant="ghost" size="sm" onClick={onDismiss}>Dismiss</Button>}
      </header>
      {lost && !done && (
        <p className="set-note upd-lost" role="status">
          <RotateCcw size={12} aria-hidden="true" /> Reconnecting - {lost.why}. The job runs on the host whatever this tab does;
          an update to Bothy itself or to Traefik interrupts this page on purpose.
        </p>
      )}
      {job && (
        <>
          <ol className="upd-steps">
            {job.steps.map((s) => (
              <li key={s.name} className="upd-step" data-state={s.state}>
                <StepGlyph state={s.state} />
                <span className="upd-step-name">{STEP_WORD[s.name]}</span>
                <span className="upd-step-when">{s.endedAt && s.startedAt ? secs(s.startedAt, s.endedAt) : s.state === 'running' ? 'now' : ''}</span>
                {s.detail && <span className="upd-step-detail"><Ticks text={s.detail} /></span>}
              </li>
            ))}
          </ol>
          {job.error && done && <p className="upd-job-err"><b>Why:</b> <Prose text={job.error} /></p>}
          {job.note && done && <p className="set-note"><Prose text={job.note} /></p>}
          <p className="set-cell-sub">
            job <span className="mono">{job.id.slice(0, 12)}</span> · asked by <Actor who={job.requestedBy} /> <When iso={job.requestedAt} />
            {job.snapshot && <> · snapshot <span className="mono upd-path">{job.snapshot}</span></>}
          </p>
        </>
      )}
    </section>
  );
}

const secs = (a: string, b: string) => {
  const s = Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000));
  return s >= 90 ? `${Math.round(s / 60)} min` : `${s} s`;
};

function StepGlyph({ state }: { state: JobStep['state'] }) {
  if (state === 'running') return <span className="sa-spin upd-step-g" aria-label="running" />;
  if (state === 'ok') return <Check size={14} className="upd-step-g" aria-label="done" />;
  if (state === 'failed') return <X size={14} className="upd-step-g" aria-label="failed" />;
  if (state === 'skipped') return <Minus size={14} className="upd-step-g" aria-label="skipped" />;
  return <CircleDashed size={14} className="upd-step-g" aria-label="pending" />;
}

function JobGlyph({ state }: { state: JobState }) {
  if (state === 'succeeded') return <Check size={15} aria-hidden="true" />;
  if (state === 'failed') return <X size={15} aria-hidden="true" />;
  if (state === 'rolled_back') return <RotateCcw size={15} aria-hidden="true" />;
  return <AlertTriangle size={15} aria-hidden="true" />;
}

// ── history ──────────────────────────────────────────────────────────────────

const HIST_WORD: Record<JobState, string> = {
  queued: 'queued', running: 'running', succeeded: 'updated', rolled_back: 'rolled back', aborted: 'aborted',
  failed: 'failed', refused: 'refused',
};

function History({ d }: { d: UpdatesStatus | null }) {
  const h: HistoryEntry[] = d?.history ?? [];
  if (h.length === 0) {
    return <p className="set-empty">No update has run from here yet. Each one leaves a line in the host’s{' '}
      <span className="mono">~/.local/state/bothy/updates/history.jsonl</span>.</p>;
  }
  return (
    <div className="tbl-wrap set-tbl">
      <table className="tbl upd-tbl upd-hist">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Component</th>
            <th scope="col">Change</th>
            <th scope="col">Result</th>
            <th scope="col">Snapshot</th>
          </tr>
        </thead>
        <tbody>
          {h.map((e) => (
            <tr key={e.id}>
              <td data-label="When"><When iso={e.endedAt ?? e.requestedAt} />
                <span className="set-cell-sub"><Actor who={e.requestedBy} />{e.durationMs != null && ` · ${Math.round(e.durationMs / 1000)} s`}</span></td>
              <td data-label="Component"><b>{e.component}</b></td>
              <td data-label="Change">
                <span className="mono upd-tag">{e.from?.version ?? e.from?.image ?? '?'} → {e.to?.version ?? e.to?.image ?? '?'}</span>
              </td>
              <td data-label="Result">
                <span className="upd-result" data-tone={STATE_TONE[e.state]}><JobGlyph state={e.state} />{HIST_WORD[e.state]}</span>
                {e.error && <span className="set-cell-sub upd-why" title={e.error.replace(/`/g, '')}><Ticks text={e.error} /></span>}
                {e.note && <span className="set-cell-sub"><Ticks text={e.note} /></span>}
              </td>
              <td data-label="Snapshot">{e.snapshot ? <span className="mono upd-path set-cell-sub">{e.snapshot}</span> : <span className="dim">none</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── channels and the window ─────────────────────────────────────────────────

function Channels({ d }: { d: UpdatesStatus | null }) {
  const count = (ch: Channel) => d?.components.filter((r) => r.channel === ch).length ?? 0;
  const p = d?.policy;
  return (
    <div className="kv-list">
      <div className="kv"><div className="kv-k">auto</div><div className="kv-v">
        Patch releases only, applied in the night window. A minor of an auto component is only <b>notified</b>; a major is{' '}
        <b>manual</b>. Only stateless and time-series components may be auto - the catalog cannot widen that.
        {d && <span className="set-note">{count('auto')} components.</span>}
      </div></div>
      <div className="kv"><div className="kv-k">notify</div><div className="kv-v">
        Shown here with its step, and applied by a person. Grafana, Traefik, Bothy itself and the cluster add-ons.
        {d && <span className="set-note">{count('notify')} components.</span>}
      </div></div>
      <div className="kv"><div className="kv-k">manual</div><div className="kv-v">
        Never offered as one click: Keycloak, both oauth2-proxies, the Docker socket proxies and Postgres, and <b>any</b>{' '}
        major of anything.
        {d && <span className="set-note">{count('manual')} components.</span>}
      </div></div>
      <div className="kv"><div className="kv-k">Night window</div><div className="kv-v">
        {p ? <>{p.windowStart}–{p.windowEnd}</> : '03:30–05:00'} local time, only if that night’s{' '}
        <span className="mono">{p?.requireBackup ?? 'stacks-backup.service'}</span> succeeded and the component itself was
        healthy, its canaries green. At most {p?.maxAutoPerNight ?? 1} automatic update a night, stopping at the first failure. A
        rollback or a failed verify pauses auto for that component until an operator clears it (<b>Unpause</b> on its row, or{' '}
        <Cmd>just update-unpause &lt;component&gt;</Cmd>). A night the box slept through is skipped, never caught up.
        <LastNight d={d} />
      </div></div>
      <div className="kv"><div className="kv-k">One-way</div><div className="kv-v">
        <span className="upd-oneway"><Lock size={12} aria-hidden="true" />one-way</span>{' '}
        marks a component whose first start on a new version migrates data the old version cannot read - rolling back is
        a restore, not a re-pin. Take a backup first.
      </div></div>
    </div>
  );
}

function LastNight({ d }: { d: UpdatesStatus | null }) {
  const a = d?.auto;
  if (!a) return null;
  if (!a.enabled) {
    return <span className="set-note"><b>Automatic updates are off</b> (<span className="mono">max_auto_per_night = 0</span> in updates.toml).</span>;
  }
  const l = a.last;
  if (!l) {
    return <span className="set-note">The night job has not run yet - <span className="mono">bothy-updater-auto.timer</span> fires at 03:30.</span>;
  }
  return (
    <span className="set-note">
      Last night job <When iso={l.at} />: <b>{l.outcome === 'requested' ? `requested ${l.component ?? 'an update'}` : 'nothing done'}</b>
      {l.reason && <> - <Ticks text={l.reason} /></>}
      {a.paused.length > 0 && <>. Paused: {a.paused.map((c, i) => <span key={c}>{i > 0 && ', '}<span className="mono">{c}</span></span>)}</>}.
    </span>
  );
}

// ── how applying works, and what is still by hand ───────────────────────────

function Apply({ d }: { d: UpdatesStatus | null }) {
  // What the updater will not do, and what to do instead.
  const manual = (d?.components ?? []).filter((r) => (r.level || r.discovered?.drift) && !r.plan?.deployable);
  return (
    <>
      <div className="kv-list">
        <div className="kv"><div className="kv-k">What Update does</div><div className="kv-v">
          Deploys what the checkout’s <span className="mono">main</span> already pins and is not running yet - nothing else.
          The host re-checks the plan, runs the pre-flight, takes a snapshot, pulls, runs the component’s recipe, then checks
          the component’s canaries <b>by their bodies</b>. Any failure puts the old image back.
          <span className="set-note">
            It runs as a host job (<span className="mono">bothy-updater.service</span>), not in bothy-ops: this page only drops one
            request in a spool. It keeps running if you close the tab.
          </span>
        </div></div>
        <div className="kv"><div className="kv-k">Bothy itself</div><div className="kv-v">
          Deploys the newest <b>release tag</b> CI marked green (release.yml tags only a commit whose CI passed on{' '}
          <span className="mono">main</span>), never main’s tip. The new images are built before anything running changes; a
          rollback timer is armed before the checkout moves, and puts the previous commit and images back unless verify
          passes. The same path runs from a shell: <Cmd>bothy upgrade</Cmd>.
          <span className="set-note">Open tabs are told to reload when the page they loaded is no longer the one being served.</span>
        </div></div>
        <div className="kv"><div className="kv-k">Getting a newer version</div><div className="kv-v">
          Merge its Dependabot PR, then on the box <Cmd>git pull --ff-only</Cmd> and <Cmd>just updates-discover</Cmd>. The
          row then offers <b>Update</b>. A version <span className="mono">main</span> does not pin is never offered, so git
          stays the only record of what the box should run.
        </div></div>
        <div className="kv"><div className="kv-k">From a shell</div><div className="kv-v">
          <Cmd>systemctl status bothy-updater.service</Cmd>
          <span className="set-note">Recovery never needs this page: the job’s status, history and audit lines live under{' '}
            <span className="mono">~/.local/state/bothy/updates/</span>, and every snapshot under{' '}
            <span className="mono">~/backups/pre-update/</span>.</span>
        </div></div>
      </div>
      {manual.length > 0 && (
        <div className="set-subsection">
          <h3 className="set-h3">Still by hand<span className="set-h3-sub">{manual.length} components</span></h3>
          <ul className="upd-todo">
            {manual.map((r) => {
              const d2 = r.discovered!;
              const target = d2.latest?.tag;
              return (
                <li key={r.id}>
                  <b>{r.title}</b>{' '}
                  {target && d2.latest?.level ? (
                    <>
                      <span className="mono">{d2.current.tag ?? 'digest'}</span> → <span className="mono">{target}</span>{' '}
                      <LevelBadge level={d2.latest.level} />: merge its Dependabot PR (or edit{' '}
                      {[...new Set(r.pins.map(pinFile))].map((f, i) => (
                        <span key={f}>{i > 0 && ' and '}<span className="mono">{f}</span></span>
                      ))}), then <Cmd>{r.apply}</Cmd>
                    </>
                  ) : (
                    <>drifting - <Cmd>{r.apply}</Cmd> brings it back to its pin</>
                  )}
                  {r.plan && !r.plan.deployable && <span className="set-note">Not one click: <Ticks text={r.plan.reason} /></span>}
                  {r.oneWay && <span className="set-note">One-way: run <Cmd>just backup</Cmd> first. {r.oneWayWhy}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="kv-list">
        <div className="kv"><div className="kv-k">The design</div><div className="kv-v">
          <Link className="link" to={filesHref('read', 'stacks', 'docs/plans/updates.md')}>docs/plans/updates.md</Link>
          <span className="set-note">Plans, snapshots, verify and rollback - and why the updater runs on the host, not in a container.</span>
        </div></div>
      </div>
    </>
  );
}
