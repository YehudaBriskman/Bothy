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
//
// ── Controls (2026-10-06): the two things the CLI could do and the page could not ─
//
// POST /-/api/updates/discover and /-/api/updates/autorun, both operator, both the
// same shape as everything else here: one file in the spool, and the HOST decides.
// They exist because the page SHOWED two states and could not change them - "checked
// 5 h ago" (discovery is a six-hourly timer) and "nothing done last night" (the
// night job's decision was readable, not re-askable). A shell is not an answer to a
// stale page.
//
//   Check for updates    discovery, read-only, rate-limited BY THE HOST - so the
//                        button says how long is left rather than being refused.
//   What would tonight    the night job in dry-run: writes nothing at all. This is
//   do?                   the one that answers "why nothing last night?".
//   Run the night job     the night job for real. It keeps its window, its backup,
//                         one a night, the pauses and the narrow doctor, so outside
//                         03:30-05:00 the honest answer IS "outside the window" -
//                         that reason is the point, not a failure. It confirms in a
//                         dialog because it can end in a deploy, and takes a click
//                         rather than the typed name, because what it may deploy is
//                         a patch of a two-way class (design batch 5: typing the
//                         name is for the irreversible).
//
// WHAT IS NOT HERE, on purpose. Editing a component's channel (the plan's §8 extra)
// would let a click arm unattended deployment - and `updates.toml` is COPY'd into
// bothy-ops' image, so writing it would need a read-write mount of the checkout,
// which is exactly what SECURITY.md rule 8 says bothy-ops does not have. A history
// row's Roll back is not here either: the host has no deliberate-rollback plan to
// ask for yet, only the automatic one a failed verify runs. `just install-updater`
// and `just release` are not update operations - the first is the person's step that
// switches the program validating the next request, and the page says so above when
// one is staged.
//
// A viewer sees all three as one NeedsRole note, never as disabled buttons.

import { Loader } from '../../components/ui/Loader';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, ArrowUpRight, Check, ChevronDown, CircleArrowUp, CircleDashed, CirclePause, Layers, Lock, Minus, RotateCcw, X,
} from 'lucide-react';
import { filesHref } from '../files/routes';
import { SettingBlock } from '../../components/settings/SettingBlock';
import { Cmd, Loading, Prose, Refusal, When, fmtBytes, useLoad } from '../../components/settings/bits';
import { Dialog } from '../../components/ui/Dialog';
import { Disclosure } from '../../components/ui/Disclosure';
import { InfoHint } from '../../components/ui/InfoHint';
import '../../components/ServiceActions.css';
import '../../components/KubeActions.css';
import { useOperator } from '../../lib/session';
import { statusOf } from '../../lib/http';
import {
  AUTO_ACTOR, applyGroup, askDiscover, askNightJob, fetchGroup, fetchJob, fetchPlan, fetchUpdates,
  groupSkipped, isTerminal,
  pinFile, publishBehind,
  rememberJob, rememberedJob,
  requestUpdate, unpauseAuto,
  type AskRecord, type AutorunRecord,
  type Channel, type GroupPlan, type GroupRow, type HistoryEntry, type Job, type JobState, type JobStep,
  type Level, type OwnPlan, type Plan, type UpdateRow,
  type UpdatesStatus, type UpdaterInfo,
} from '../../lib/updates';
import { Button } from '../../components/ui/Button';
import { EmptyState, NeedsRole } from '../../components/states';
import { Icon } from '../../components/ui/Icon';

export function UpdatesSettings() {
  const { data, error, loading, reload } = useLoad((signal) => fetchUpdates(signal));
  const { canAct } = useOperator();
  const [planFor, setPlanFor] = useState<UpdateRow | null>(null);
  const [groupFor, setGroupFor] = useState<GroupRow | null>(null);
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
    setGroupFor(null);
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
      {/* WHAT IS HAPPENING SITS ON THE RIGHT, IN A SLOT THAT IS ALWAYS THERE (D3,
          2026-10-07). The owner's words: "i want the actions that happening to be
          in the right side of the page, without the sudden jump of the ui for the
          real-time-update-actions card."

          The jump was structural, not animated: JobPanel was mounted into the page
          flow the moment a job existed, so pressing Apply inserted a ~300px panel
          above everything and every block below it moved down - while the reader
          was looking at the row they had just pressed.

          So the rail is a GRID COLUMN that exists whether or not a job does, and
          the card inside it is absolutely positioned, which is the part that makes
          the no-shift guarantee structural rather than a guess: an absolutely
          positioned child contributes NO height, so the row's height is decided
          entirely by the left column and the panel cannot push anything, however
          many steps it grows. At rest the slot is not empty - it carries the last
          job, which is the one fact somebody opening this page while nothing runs
          actually wants.

          BELOW 1100px THERE IS NO RIGHT, and the honest answer is a band of the
          same fixed height across the top (settings.css): still reserved, still
          never shifting, and still carrying the last job when nothing runs. */}
      <div className="upd-top">
        <div className="upd-top-main">
          {data && <Freshness d={data} />}
          {data?.updater?.staged && <UpdaterStaged u={data.updater} />}
          <SettingBlock id="update-controls" badge="operator">
            {loading && !data ? <Loading rows={2} /> : <Controls d={data} canAct={canAct} onChanged={reload} />}
          </SettingBlock>
        </div>
        <div className="upd-rail">
          {/* The scroller takes the app's shared edge cue (lib/scroll.ts drives
              every .scroll-shade) and a tab stop, because at 390px a live panel
              is taller than its band and a scroller nothing can focus is a
              scroller a keyboard cannot reach. */}
          <div className="upd-rail-in scroll-shade" tabIndex={0} role="region" aria-label="Update activity">
            {jobId
              ? <JobPanel id={jobId} key={jobId} onFinished={reload} onDismiss={dismiss} />
              : <RestingJob d={data} />}
          </div>
        </div>
      </div>
      {data?.groups && data.groups.length > 0 && (
        <SettingBlock id="update-groups" badge="apply: operator">
          <Groups d={data} canAct={canAct} busy={!!jobId && !!data.applying} onApply={setGroupFor} />
        </SettingBlock>
      )}
      <SettingBlock id="update-components" badge="viewer · apply: operator">
        {loading && !data ? <Loading rows={8} /> : error ? fail : data && (
          <Components d={data} canAct={canAct} busy={!!jobId && !!data.applying} onUpdate={setPlanFor}
            onGroup={setGroupFor} onChanged={reload} />
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
      {groupFor && <GroupDialog row={groupFor} onClose={() => setGroupFor(null)} onStarted={started} />}
    </>
  );
}

function Freshness({ d }: { d: UpdatesStatus }) {
  const s = d.summary;
  if (!d.discovery.present) {
    return (
      <p className="set-fresh is-stale" role="status">
        <Icon icon={AlertTriangle} size="sm" />
        <span><Prose text={d.discovery.hint ?? 'Nothing discovered yet - run `just updates-discover` on the host.'} /></span>
      </p>
    );
  }
  const ready = d.components.filter((r) => r.plan?.deployable).length;
  const paused = d.components.filter((r) => r.paused).length;
  const groups = (d.groups ?? []).filter((g) => g.deployable);
  return (
    <p className={`set-fresh ${d.discovery.stale ? 'is-stale' : ''}`} role="status">
      {d.discovery.stale && <Icon icon={AlertTriangle} size="sm" />}
      <span>
        {/* APPLY FIRST, and in its own words. This page's action is Apply - make
            the box run what `main` already pins - and the count that drives it is
            `ready`. `updates` is the UPSTREAM question, answered by merging a PR
            somewhere else, and it had the only headline: it read "2 with a newer
            version" on a box where ten components were behind on apply, which is
            how three refusals in a row came to look like a fault. */}
        {ready > 0
          ? <><b>{ready}</b> {ready === 1 ? 'component has a pin' : 'components have pins'} this box has not
            applied{groups.length > 0 && <> · <b>{groups.length}</b> whole {groups.length === 1 ? 'recipe' : 'recipes'} can
              be applied at once</>} · </>
          : <>Everything <span className="mono">main</span> pins is applied · </>}
        {s.components} components · {s.updates} with a newer version upstream · <b>{s.behind}</b> a minor or more behind
        {s.drift > 0 && <> · {s.drift} drifting</>}
        {s.errors > 0 && <> · {s.errors} not checked</>}
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
      <Icon icon={AlertTriangle} size="sm" />
      <span>
        A new updater is staged (<span className="mono">{u.staged!.slice(0, 12)}</span>, <When iso={u.stagedAt} />) beside the
        one that runs (<span className="mono">{u.current ? u.current.slice(0, 12) : 'none'}</span>). Bothy was updated; the
        program that updates it switches only when you say so: <Cmd>just install-updater</Cmd> on the host.
      </span>
    </p>
  );
}

// ── Controls: the two asks ───────────────────────────────────────────────────
//
// Both answer the same way: the ask lands in the spool, the row says it is waiting
// for the host, and the host's own record replaces that a moment later. Neither
// control claims an outcome itself - `asks.discover` and `asks.autorun` are what the
// HOST wrote, and a discovery that found nothing new looks identical to one that was
// refused unless the host says which.

type Phase =
  | { t: 'idle' }
  | { t: 'sending' }
  | { t: 'asked' }
  | { t: 'refused'; error: unknown };

const ASK_WORD: Record<AskRecord['outcome'], string> = {
  ok: 'Ran', skipped: 'Nothing done', refused: 'Refused', failed: 'Failed',
};

// What an outcome means in the reserved palette. `skipped` is deliberately NOT a
// warning: a gate that said no is the answer, not a fault.
const ASK_TONE: Record<AskRecord['outcome'], 'up' | 'off' | 'warn' | 'down'> = {
  ok: 'up', skipped: 'off', refused: 'warn', failed: 'down',
};

function AskGlyph({ outcome }: { outcome: AskRecord['outcome'] }) {
  if (outcome === 'ok') return <Icon icon={Check} size="sm" />;
  if (outcome === 'skipped') return <Icon icon={Minus} size="sm" />;
  if (outcome === 'failed') return <Icon icon={X} size="sm" />;
  return <Icon icon={AlertTriangle} size="sm" />;
}

/** The host's record of one ask: a glyph, a word, when, who, and why. */
function AskOutcome({ r, what }: { r: AskRecord; what: string }) {
  return (
    <>
      <span className="upd-ask-out" data-tone={ASK_TONE[r.outcome]}>
        <AskGlyph outcome={r.outcome} />{ASK_WORD[r.outcome]}
      </span>
      <span className="set-cell-sub">
        {what} <When iso={r.at} />
        {r.askedBy && <> · asked by {r.askedBy}</>}
        {r.tookMs != null && r.tookMs >= 1000 && <> · took {Math.round(r.tookMs / 1000)} s</>}
      </span>
      {r.reason && <span className="set-cell-sub upd-why"><Ticks text={r.reason} /></span>}
    </>
  );
}

const mins = (s: number) => (s >= 90 ? `${Math.round(s / 60)} min` : `${s} s`);

function Controls({ d, canAct, onChanged }: { d: UpdatesStatus | null; canAct: boolean; onChanged: () => void }) {
  const a = d?.asks;
  const [confirming, setConfirming] = useState(false);
  if (!d) return null;
  if (!a) {
    // The partial state: a bothy-ops from before these routes existed still serves
    // every read, so the page is whole except for this block.
    return (
      <EmptyState
        message="This bothy-ops does not serve the update controls."
        hint={<Prose text={'They arrived with the routes `/-/api/updates/discover` and `/-/api/updates/autorun`. '
          + 'On the host: `just updates-discover` and `just update-auto --dry-run`.'} />}
      />
    );
  }
  // The rate limit is the HOST's, off available.json's mtime; this is the same
  // arithmetic, so the control can say how long is left instead of being refused.
  const age = d.discovery.ageSeconds;
  const left = age == null ? 0 : Math.max(0, a.discoverMinSeconds - age);
  return (
    <>
      {canAct ? (
        <div className="upd-ctl">
          <Ask
            label="Check for updates"
            busy="search"
            title="Ask the host to look at every pin, the registries, GitHub releases and the helm index, and rewrite the plans."
            queued={a.discoverQueued}
            waiting="checking - waiting for the host"
            disabledWhy={left > 0
              ? `Checked ${mins(age ?? 0)} ago. Again in ${mins(left)} - it asks public registries on an `
                + 'anonymous quota shared with every pull this box makes.'
              : null}
            send={() => askDiscover()}
            onChanged={onChanged}
          />
          <Ask
            label="What would tonight do?"
            variant="ghost"
            busy="act"
            title="Run the night job's gates and say what it would pick. Writes nothing at all."
            queued={a.autorunQueued}
            waiting="deciding - waiting for the host"
            send={() => askNightJob(true)}
            onChanged={onChanged}
          />
          {/* The same wrapper as the other two, so that when it is disabled - a run
              is already waiting for the host - the reason is the line underneath
              rather than a tooltip nobody hovers. */}
          <div className="upd-ask">
            <Button variant="caution" onClick={() => setConfirming(true)} disabled={a.autorunQueued}
              title="Ask the night job to decide now. It keeps its window, its backup and all its gates.">
              Run the night job…
            </Button>
            {a.autorunQueued && <Loader state="connect" size="sm" label="a night-job run is waiting for the host" />}
          </div>
        </div>
      ) : (
        <div className="upd-ctl-norole">
          <NeedsRole
            what="Checking for updates and running the night job"
            role="operator"
            detail={'Both make the host run something, so the edge would refuse them before they reached '
              + 'bothy-ops. Everything below is readable without it.'}
          />
        </div>
      )}
      <div className="kv-list">
        <div className="kv"><div className="kv-k">Last check{' '}
          <InfoHint label="What a check does, and does not do" side="bottom" align="start">
            <p>Discovery reads the pins and asks upstream. It pulls nothing and restarts nothing.</p>
          </InfoHint>
        </div><div className="kv-v">
          {a.discover
            ? <AskOutcome r={a.discover} what="on the host" />
            : <span className="dim">Nothing has been asked for from here. The timer checks every{' '}
              {d.policy.discoverEveryHours} hours.</span>}
          <span className="set-note">From a shell: <Cmd>just updates-discover</Cmd></span>
        </div></div>
        <div className="kv"><div className="kv-k">Last night job asked from here</div><div className="kv-v">
          {a.autorun ? <NightRun r={a.autorun} /> : (
            <span className="dim">Nothing has been asked for from here. The timer runs it at{' '}
              {d.policy.windowStart}; its own last decision is under <b>Channels</b>.</span>
          )}
          <span className="set-note">From a shell: <Cmd>just update-auto --dry-run</Cmd></span>
        </div></div>
      </div>
      {confirming && (
        <NightJobDialog
          d={d}
          onClose={() => setConfirming(false)}
          onAsked={() => { setConfirming(false); onChanged(); }}
        />
      )}
    </>
  );
}

/** One ask button, with its own in-flight and waiting-for-the-host states. */
function Ask({ label, title, busy, queued, waiting, disabledWhy, send, onChanged, variant }: {
  label: string;
  title: string;
  busy: 'search' | 'act';
  queued: boolean;
  waiting: string;
  disabledWhy?: string | null;
  send: () => Promise<unknown>;
  onChanged: () => void;
  variant?: 'secondary' | 'ghost';
}) {
  const [phase, setPhase] = useState<Phase>({ t: 'idle' });
  const pending = queued || phase.t === 'asked';
  // The host answers a moment after the file lands. Look again until the row says
  // so, rather than claiming an outcome here.
  useEffect(() => {
    if (!pending) return undefined;
    const t = setTimeout(onChanged, 3000);
    return () => clearTimeout(t);
  }, [pending, onChanged, queued]);
  useEffect(() => { if (!queued && phase.t === 'asked') setPhase({ t: 'idle' }); }, [queued, phase.t]);
  const go = async () => {
    setPhase({ t: 'sending' });
    try {
      await send();
      setPhase({ t: 'asked' });
      onChanged();
    } catch (e) {
      setPhase({ t: 'refused', error: e });
    }
  };
  return (
    <div className="upd-ask">
      <Button variant={variant ?? 'secondary'} onClick={() => void go()}
        disabled={phase.t === 'sending' || pending || !!disabledWhy} title={title}>
        {label}
      </Button>
      {phase.t === 'sending' && <Loader state={busy} size="sm" label="Asking the host…" />}
      {pending && phase.t !== 'sending' && <Loader state="connect" size="sm" label={waiting} />}
      {disabledWhy && <span className="set-cell-sub upd-ask-why">{disabledWhy}</span>}
      {phase.t === 'refused' && <PlanRefusal error={phase.error} />}
    </div>
  );
}

/** A night-job run: its outcome, and every component it passed over, with why. */
function NightRun({ r }: { r: AutorunRecord }) {
  return (
    <>
      <AskOutcome r={r} what={r.dryRun ? 'a dry run on the host' : 'on the host'} />
      {r.component && (
        <span className="set-cell-sub">
          {r.dryRun ? 'would pick' : 'picked'} <span className="mono">{r.component}</span>
          {r.jobId && <> · job <span className="mono">{r.jobId.slice(0, 12)}</span></>}
        </span>
      )}
      {r.skipped.length > 0 && (
        <ul className="upd-list upd-ask-skipped">
          {r.skipped.map((s) => (
            <li key={s.component}><span className="mono">{s.component}</span> - <Ticks text={s.why} /></li>
          ))}
        </ul>
      )}
    </>
  );
}

// A click, not the typed name: what the night job may deploy is a PATCH of a
// stateless or time-series component - reversible by re-pinning the old digest
// (docs/brand/patterns/feedback.md, "confirmation weight follows reversibility").
// The dialog exists because it can end in a deploy at all, and it names what it
// cannot do, because that is the question somebody clicking this actually has.
function NightJobDialog({ d, onClose, onAsked }: { d: UpdatesStatus; onClose: () => void; onAsked: () => void }) {
  const [phase, setPhase] = useState<Phase>({ t: 'idle' });
  const p = d.policy;
  const go = async () => {
    setPhase({ t: 'sending' });
    try {
      await askNightJob(false);
      onAsked();
    } catch (e) {
      setPhase({ t: 'refused', error: e });
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title="Run the night job now"
      description="The host runs the same gates the 03:30 timer runs. This asks for a decision; it does not make one."
    >
      <div className="ka-body upd-plan">
        <dl className="upd-dl">
          <dt>What it may do</dt>
          <dd>Deploy <b>at most one</b> update: an <span className="mono">auto</span>-channel component whose plan is
            a <b>patch</b> of what <span className="mono">main</span> already pins. Never a minor, never a major,
            never a one-way component, never Bothy itself.</dd>
          <dt>What stops it</dt>
          <dd><ul className="upd-list">
            <li>Outside <span className="mono">{p.windowStart}</span>–<span className="mono">{p.windowEnd}</span> it
              does nothing and says so. <b>That is the usual answer by day</b>, and it is not a failure.</li>
            <li>Tonight&rsquo;s <span className="mono">{p.requireBackup}</span> must have succeeded and left a fresh
              dump.</li>
            <li>At most {p.maxAutoPerNight} a night, stopping at the first failure.</li>
            <li>A paused component is skipped; the component must be healthy now, its canaries green.</li>
          </ul></dd>
          <dt>Who it is recorded as</dt>
          <dd>The job is the night job&rsquo;s, so its actor is <span className="mono">{AUTO_ACTOR}</span> - the host
            chose the component, the level and the plan. That you asked for it early is recorded beside it.</dd>
          <dt>From a shell</dt>
          <dd><Cmd>just update-auto</Cmd></dd>
        </dl>
        {phase.t === 'refused' && <PlanRefusal error={phase.error} />}
        <div className="ka-row">
          <Button variant="ghost" onClick={onClose}>Leave it alone</Button>
          <Button variant="caution" onClick={() => void go()} disabled={phase.t === 'sending'}>
            {phase.t === 'sending' ? 'Asking the host…' : 'Ask the night job to run'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ── groups: everything one recipe pins, in one compose up ───────────────────
//
// A compose recipe IS one `docker compose up`, so the host refuses to apply one
// component while another service of the same project also has a merged pin
// waiting - it would drag that one's migration along with no snapshot. Where two
// are waiting that refusal is total: every row's Apply is refused, each naming
// the others, and the page's only answer was a shell. This block is the answer.
//
// It sits ABOVE the per-component table on purpose. When a group is deployable,
// its members' own Apply cannot succeed, so the group is the action and the rows
// below are its detail - not two equal choices.

function Groups({ d, canAct, busy, onApply }: {
  d: UpdatesStatus; canAct: boolean; busy: boolean; onApply: (g: GroupRow) => void;
}) {
  const gs = d.groups ?? [];
  return (
    <>
      <ul className="upd-groups">
        {gs.map((g) => <GroupItem key={g.group} g={g} canAct={canAct} busy={busy} onApply={onApply} />)}
      </ul>
    </>
  );
}

function GroupItem({ g, canAct, busy, onApply }: {
  g: GroupRow; canAct: boolean; busy: boolean; onApply: (g: GroupRow) => void;
}) {
  const p = g.plan;
  const skipped = groupSkipped(g);
  return (
    <li className="upd-group" data-deployable={g.deployable ? 'true' : 'false'}>
      <div className="upd-group-h">
        <span className="upd-group-n">
          <Icon icon={Layers} size="sm" />
          <span className="mono">{g.recipe ?? `just ${g.group}`}</span>
          {/* The four sentences that used to sit under this list as a footer note
              for every reader, whether or not they had asked. */}
          <InfoHint label="Why a recipe is applied as a whole" side="bottom" align="start">
            <p>
              A recipe is one <span className="mono">docker compose up</span>, so a component whose project has
              another merged pin waiting <b>cannot be applied on its own</b> - the host refuses, rather than
              recreate the other service with no snapshot of it.
            </p>
            <p>
              Applying the group takes every member&rsquo;s own snapshot first, needs the strictest confirmation
              any member needs, and <b>rolls all of them back together</b>. It is never automatic.
            </p>
          </InfoHint>
        </span>
        {p ? (
          <span className="upd-group-sub">
            {p.members.length} components in one apply{p.project && <> · project <span className="mono">{p.project}</span></>}
            {p.oneWay && <> · <span className="upd-oneway"><Icon icon={Lock} size="xs" />one-way member</span></>}
          </span>
        ) : (
          <span className="upd-group-sub dim">nothing to apply together</span>
        )}
        <span className="upd-group-act">
          {p && canAct && (
            <Button size="sm" variant="caution" onClick={() => onApply(g)} disabled={busy}
              title={busy ? 'An update is running - one at a time' : `Apply all of ${p.recipe}`}>
              Apply all {p.members.length}…
            </Button>
          )}
          {p && !canAct && <span className="set-cell-sub">needs <span className="mono">operator</span></span>}
        </span>
      </div>
      {p ? (
        <ul className="upd-list upd-group-m">
          {p.members.map((m) => (
            <li key={m.component}>
              <b>{m.title ?? m.component}</b>{' '}
              <span className="mono upd-tag">{m.from.version ?? m.from.tag} → {m.to.version ?? m.to.tag}</span>{' '}
              {m.level && <LevelBadge level={m.level} />}
              {m.oneWay && <span className="upd-oneway"><Icon icon={Lock} size="xs" />one-way</span>}
            </li>
          ))}
        </ul>
      ) : (
        /* D1: THE PAGE SAID NOTHING HERE, and that is why the owner asked twice
           why they could not see the option to apply the six together. The host
           had written a perfectly good sentence; the two halves of it were glued
           together into one string and then cut off at 300 characters, so what
           reached the page ended "...grafana: noth" (updater/groups.py now keeps
           them apart). The sentence is the answer and goes on the surface; the
           per-component list is detail and goes behind the hint. */
        <p className="upd-reason">
          <Ticks text={g.reason ?? 'no group plan'} />
          {skipped.length > 0 && (
            <InfoHint label={`What each component of ${g.recipe ?? g.group} is doing`} side="bottom" align="start">
              <p>Every component of this recipe, and what it is waiting on:</p>
              <ul>
                {skipped.map((x) => (
                  <li key={x.component}><b>{x.component}</b> - <Ticks text={x.reason} /></li>
                ))}
              </ul>
            </InfoHint>
          )}
        </p>
      )}
    </li>
  );
}

/** The group plan, and the one confirmation that approves all of it. */
function GroupDialog({ row, onClose, onStarted }: { row: GroupRow; onClose: () => void; onStarted: (jobId: string) => void }) {
  const { data, error, loading } = useLoad((signal) => fetchGroup(row.group, signal), [row.group]);
  const [typed, setTyped] = useState('');
  const [phase, setPhase] = useState<{ t: 'idle' } | { t: 'sending' } | { t: 'refused'; error: unknown }>({ t: 'idle' });
  const firing = useRef(false);
  const plan = data?.plan ?? null;
  const ready = !!plan && (plan.confirm === 'click' || typed === plan.group) && phase.t !== 'sending';

  const go = async () => {
    if (!plan || !ready || firing.current) return;
    firing.current = true;
    setPhase({ t: 'sending' });
    try {
      const r = await applyGroup({ group: plan.group, plan_id: plan.id,
        confirm: plan.confirm === 'click' ? true : typed });
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
      title={<span className="sa-title">Apply all of <span className="mono">{row.recipe ?? row.group}</span></span>}
      description="One docker compose up for every component of this recipe that main pins and this box is not running. Approving it approves this group plan id - the host re-derives the whole thing, and every member's plan, and refuses one that is no longer current."
    >
      <div className="ka-body upd-plan">
        {loading ? <p className="sa-working"><Loader state="load" size="sm" label="Reading the group plan…" /></p>
          : error ? <PlanRefusal error={error} />
            : !plan ? (
              <EmptyState
                message="Nothing to apply together."
                hint={<Prose text={data?.reason ?? 'The host wrote no group plan for this recipe.'} />}
              />
            ) : (
              <>
                <GroupFacts plan={plan} age={data?.ageSeconds ?? null} />
                {phase.t === 'refused' && <PlanRefusal error={phase.error} />}
                <form className="ka-confirm" onSubmit={(e) => { e.preventDefault(); void go(); }}>
                  <p className="sa-warn">
                    <Icon icon={AlertTriangle} size="md" />
                    <span>
                      This recreates {plan.services.join(', ')} on the host, in one{' '}
                      <span className="mono">{plan.recipe}</span>. Signed out: {plan.signedOut}.
                      {' '}<b>A rollback puts all of them back together</b> - there is no keeping the ones that worked.
                    </span>
                  </p>
                  {plan.confirm === 'type-name' && (
                    <label className="ka-field">
                      {/* The GROUP's name, not a member's: what is being approved is
                          the whole apply. The host refuses anything else. */}
                      <span className="ka-label">
                        Type <span className="mono">{plan.confirmWord ?? plan.group}</span> to confirm - this group
                        includes {plan.oneWay ? 'a one-way migration' : 'a major step'}
                      </span>
                      <input
                        className="ka-input mono" autoComplete="off" spellCheck={false} value={typed}
                        onChange={(e) => setTyped(e.target.value)}
                        aria-invalid={typed.length > 0 && typed !== plan.group}
                      />
                    </label>
                  )}
                  <div className="ka-row">
                    <Button variant="ghost" onClick={onClose}>Leave it alone</Button>
                    <Button variant="caution" type="submit" disabled={!ready}>
                      {phase.t === 'sending' ? 'Asking the host…' : `Apply ${plan.members.length} components`}
                    </Button>
                  </div>
                </form>
              </>
            )}
      </div>
    </Dialog>
  );
}

function GroupFacts({ plan, age }: { plan: GroupPlan; age: number | null }) {
  return (
    <div className="upd-plan-facts">
      <ul className="upd-list upd-group-diff">
        {plan.members.map((m) => (
          <li key={m.component}>
            <b>{m.title ?? m.component}</b>{' '}
            <span className="mono upd-tag">{m.from.image}</span>
            <Icon icon={ArrowRight} size="xs" />
            <span className="mono upd-tag">{m.to.image}</span>{' '}
            {m.level && <LevelBadge level={m.level} />}
            {m.oneWay && <span className="upd-oneway"><Icon icon={Lock} size="xs" />one-way</span>}
            <span className="set-cell-sub">
              {m.class} · snapshot: {m.snapshot} ·{' '}
              {m.pins.map((q, i) => <span key={`${q.file}:${q.service}`}>{i > 0 && ', '}
                <span className="mono">{q.file}:{q.line ?? '?'}</span></span>)}
              {m.changelog && <> · <a className="link upd-cl" href={m.changelog} target="_blank" rel="noreferrer noopener">
                changelog<Icon icon={ArrowUpRight} size="xs" /></a></>}
            </span>
          </li>
        ))}
      </ul>
      <dl className="upd-dl">
        <dt>One apply</dt>
        <dd><span className="mono">{plan.recipe}</span> over project <span className="mono">{plan.project}</span>,
          recreating exactly <span className="mono">{plan.services.join(', ')}</span> - the same scope check a single
          component gets, over the union of these members.</dd>
        {plan.skipped.length > 0 && (
          <><dt>Not in it</dt>
            <dd><ul className="upd-list">{plan.skipped.map((s) => (
              <li key={s.component}><span className="mono">{s.component}</span> - <Ticks text={s.reason} /></li>
            ))}</ul></dd></>
        )}
        <dt>Restarts</dt>
        <dd>{plan.restarts.join(', ')}</dd>
        <dt>Downtime</dt>
        <dd>{plan.downtime}</dd>
        <dt>Signed out</dt>
        <dd>{plan.signedOut}</dd>
        <dt>Snapshot</dt>
        <dd><Ticks text={plan.snapshot.what ?? ''} /> <span className="set-cell-sub">
          into <span className="mono">{plan.snapshot.dir}</span>
          {plan.snapshot.estimateBytes != null && <> · about {fmtBytes(plan.snapshot.estimateBytes)}</>} · the last 3 are kept</span></dd>
        {plan.oneWay && <><dt>One-way</dt><dd className="set-warn"><Icon icon={Lock} size="xs" />{plan.oneWayWhy}</dd></>}
        <dt>Pre-flight</dt>
        <dd><ul className="upd-list">{plan.preflight.map((x) => <li key={x}><Ticks text={x} /></li>)}</ul></dd>
        <dt>Verify</dt>
        <dd><ul className="upd-list">{plan.verify.map((x) => <li key={x}><Ticks text={x} /></li>)}</ul></dd>
        <dt>Rollback</dt>
        <dd><Ticks text={plan.rollback ?? ''} /></dd>
        <dt>Plan</dt>
        <dd><span className="mono">{plan.id}</span> · written <When iso={plan.createdAt} />
          {age != null && age > 12 * 3600 && <span className="set-warn"> · over 12 h old - `just updates-discover` refreshes it</span>}</dd>
      </dl>
    </div>
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

interface RowCtx {
  canAct: boolean;
  busy: boolean;
  onUpdate: (r: UpdateRow) => void;
  /** This row's group, when applying the row alone would be refused. */
  onGroup: (g: GroupRow) => void;
  onChanged: () => void;
}

function Components({ d, ...ctx }: { d: UpdatesStatus } & RowCtx) {
  // The recipe groups (above the table), by the component they would carry - so a
  // row whose Apply cannot succeed alone can hand its group to the same dialog.
  const byComponent = new Map((d.groups ?? []).flatMap((g) => g.candidates.map((c) => [c, g] as const)));
  const groups = (['auto', 'notify', 'manual'] as Channel[])
    .map((ch) => ({ ch, rows: d.components.filter((r) => r.channel === ch) }))
    .filter((g) => g.rows.length > 0);
  return (
    <>
      {/* ONE SENTENCE, AND A HINT (D2). What was here was a 105-word footer
          glossary - Apply vs Available, Drift, floating pins, groups - printed
          under the table for every reader on every visit, and it is the longest
          single paragraph on the page. One sentence survives on the surface,
          because it is the one this page's whole confusion turns on, and the rest
          is behind the glyph.

          A hint PER COLUMN HEADER was the first idea and was dropped: below 640px
          `as-cards` hides the header row, so four of the five definitions would
          have been unreachable on exactly the device the owner reads this on. */}
      <p className="upd-legend">
        <b>Apply</b> makes this box run what <span className="mono">main</span> already pins.
        <InfoHint label="Apply, Available, Drift and floating pins" side="bottom" align="start">
          <p>
            <b>Apply</b> deploys a merged pin that is not running yet. <b>Available</b> is what is newer{' '}
            <i>upstream</i>; to get that, merge its Dependabot PR first, which is a different step and happens
            elsewhere.
          </p>
          <p>
            <b>Drift</b> means what runs is not what the repository pins. A <b>floating</b> pin
            (<span className="mono">v3.7</span>, <span className="mono">17</span>) can move under you and is never
            applied by the updater.
          </p>
          <p>
            Where a recipe has more than one pin waiting, the row points at its <b>group</b> above: applying one
            alone would be refused.
          </p>
        </InfoHint>
      </p>
      <div className="tbl-wrap scroll-shade set-tbl">
        <table className="tbl as-cards upd-tbl">
          <thead>
            <tr>
              <th scope="col">Component</th>
              <th scope="col">Pinned</th>
              <th scope="col">Running</th>
              <th scope="col">Available</th>
              <th scope="col">Channel</th>
              {/* The Notes column moved into each row's disclosure - it held the
                  one-way badge, a changelog link and a freshness line, none of
                  which is state, in a cell with a 120px floor. */}
              <th scope="col"><span className="sr-only">Deploy and detail</span></th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.ch}>
              <tr className="set-tbl-sep"><td colSpan={6}>{GROUP_TITLE[g.ch]}</td></tr>
              {g.rows.map((r) => <Row key={r.id} r={r} group={byComponent.get(r.id) ?? null} {...ctx} />)}
            </tbody>
          ))}
        </table>
      </div>
    </>
  );
}

// ── one component, as a row plus a disclosure ────────────────────────────────
//
// MEASURED, which is why this changed. settings.css overrides the global
// `vertical-align: middle` with `top` and `.set-cell-sub` was emitted in FIVE OF
// SEVEN cells, so a nominal 32px row ran three to four lines; the seven columns
// carried `min-width`s summing to a ~800px floor; two cells were line-clamped to
// two and three lines; and one row could carry nine distinct mark families at
// once. A table that dense is not read, it is scanned past.
//
// The split is the rule, not a judgement call about each sub-line: THE ROW KEEPS
// IDENTITY, STATE AND THE ONE ACTION. Everything that is a note, a warning, a
// reason or plan detail moves into `ui/Disclosure` - the only component in this
// app allowed to animate a layout property, because it folds `grid-template-rows`
// from 1fr to 0fr rather than measuring a height in script (SYS-10).
//
// The Notes column is gone with its contents, so the table is six columns rather
// than seven. `as-cards` then follows its documented contract (index.css SYS-17):
// `data-label` on the four cells that need their column name, and none on the
// identifying cell or on the controls-only cell.
function Row({ r, group, canAct, busy, onUpdate, onGroup, onChanged }:
{ r: UpdateRow; group: GroupRow | null } & RowCtx) {
  const [open, setOpen] = useState(false);
  const uid = useId();
  const bodyId = `${uid}-det`;
  return (
    <>
      <tr className="upd-tr">
        <td className="upd-name">
          <b>{r.title}</b>
          <span className="set-cell-sub mono">{r.id} · {r.class}</span>
        </td>
        {/* data-label: below 640px the table becomes one card per component, and
            a cell names itself because the header row is no longer beside it. */}
        <td data-label="Pinned"><Pinned r={r} /></td>
        <td data-label="Running"><Running r={r} /></td>
        <td data-label="Available"><Available r={r} /></td>
        <td data-label="Channel"><ChannelCell r={r} /></td>
        {/* NO data-label: a controls-only cell runs the full width of the card
            and has no column name worth printing (index.css, the as-cards
            contract). */}
        <td className="upd-acts set-cell-act">
          <DeployCell r={r} group={group} canAct={canAct} busy={busy} onUpdate={onUpdate} onGroup={onGroup} />
          <Button
            variant="ghost" size="sm" iconOnly className={`upd-more${open ? ' is-open' : ''}`}
            aria-expanded={open}
            aria-controls={bodyId}
            aria-label={open ? `Hide the detail for ${r.title}` : `Show the detail for ${r.title}`}
            onClick={() => setOpen((o) => !o)}
          >
            <Icon icon={ChevronDown} size="sm" className="chev" />
          </Button>
        </td>
      </tr>
      {/* A SECOND <tr>, not a nested table: a cell cannot span the row it is in.
          Below 640px the pair is welded into one card (settings.css) - without
          that, `as-cards` would make a component's detail a card of its own,
          sitting under a card with no visible relationship to it. */}
      <tr className="upd-det-tr">
        <td colSpan={6}>
          <Disclosure open={open} id={bodyId} className="upd-det-d">
            <RowDetail r={r} group={group} canAct={canAct} onChanged={onChanged} />
          </Disclosure>
        </td>
      </tr>
    </>
  );
}

/** One label/value pair inside a row's disclosure. `dt`/`dd` rather than two
 *  spans, because that is what this is: a field of a record (patterns/data-display). */
function Det({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="upd-det-row">
      <dt className="upd-det-k">{k}</dt>
      <dd className="upd-det-v">{children}</dd>
    </div>
  );
}

/**
 * Everything the row used to say in its margins. Nothing here is new; it is the
 * same text, out of the cells and into named fields, so each one has a label
 * instead of relying on which column it happened to be under.
 */
function RowDetail({ r, group, canAct, onChanged }:
{ r: UpdateRow; group: GroupRow | null; canAct: boolean; onChanged: () => void }) {
  const d = r.discovered;
  const c = d?.current;
  const p = r.plan;
  const where = pinFile(r.pins[0]);
  const eff = r.effectiveChannel;
  const others = d && !d.error
    ? (['patch', 'minor', 'major'] as Level[]).map((lv) => d.candidates[lv]).filter((x) => x && x.tag !== d.latest?.tag)
    : [];
  return (
    <dl className="upd-det">
      <Det k="Pinned in">
        <span className="mono upd-path">{where}</span>
        {r.pins.length > 1 && <span className="set-cell-sub">and {r.pins.length - 1} more</span>}
        {c?.float && <span className="set-cell-sub">floating{c.floatTarget ? `, now ${c.floatTarget}` : ''} - a floating pin can move under you and is never deployed by the updater</span>}
        {c && !c.tag && <span className="set-cell-sub">pinned by digest</span>}
      </Det>

      {d?.drift && (
        <Det k="Drift">
          <span className="set-warn"><Icon icon={AlertTriangle} size="xs" />what runs is not what the repository pins</span>
          <span className="set-cell-sub">{d.drift}</span>
        </Det>
      )}
      {d?.notes.map((n) => <Det k="Note" key={n}>{n}</Det>)}

      {d?.error && (
        <Det k="Not checked">
          <span className="set-cell-sub upd-why">{d.error}</span>
        </Det>
      )}
      {others.length > 0 && (
        <Det k="Also available">
          {others.map((x, i) => (
            <span key={x!.tag}>{i > 0 && ', '}<span className="mono">{x!.tag}</span> ({x!.level})</span>
          ))}
        </Det>
      )}
      {d?.latest?.floating && <Det k="The tag moved">to a newer image than the one this pin first named</Det>}
      {d?.latest?.publishedAt && <Det k="Released"><When iso={d.latest.publishedAt} /></Det>}

      {eff && eff !== r.channel && (
        <Det k="Channel">
          a <span className="mono">{r.channel}</span> component;{' '}
          {r.level === 'major' ? 'a major is always manual' : 'only its patches are automatic'}
        </Det>
      )}
      {r.paused && <Det k="Automatic updates"><Paused r={r} canAct={canAct} onChanged={onChanged} /></Det>}

      {r.oneWay && (
        <Det k="One-way">
          <span className="upd-oneway"><Icon icon={Lock} size="xs" />cannot be rolled back</span>
          {r.oneWayWhy && <span className="set-cell-sub">{r.oneWayWhy}</span>}
        </Det>
      )}
      {p && !p.deployable && (
        <Det k="Not deployable"><span className="upd-reason"><Ticks text={p.reason} /></span></Det>
      )}
      {p?.deployable && <Det k="Apply would run"><span className="mono upd-tag">{p.from} → {p.to}</span> <LevelBadge level={p.level} /></Det>}
      {p?.deployable && r.applyWithGroup && (
        <Det k="Not on its own">
          <span className="set-warn"><Icon icon={Layers} size="xs" />its recipe has more than one pin waiting</span>
          <span className="set-cell-sub">
            <span className="mono">{r.apply}</span> is one <span className="mono">docker compose up</span>, so it would
            recreate the rest of {group?.plan?.project ?? 'its project'} too. The host refuses that rather than skip
            their snapshots. Apply the group{' '}
            <span className="mono">{group?.recipe ?? `just ${r.group}`}</span> above - it covers{' '}
            {group?.plan?.members.map((m) => m.component).join(', ') ?? 'every member'}.
          </span>
        </Det>
      )}
      {p?.deployable && !canAct && <Det k="Apply">needs the <span className="mono">operator</span> role</Det>}

      <Det k="Checked">{d?.checkedAt ? <When iso={d.checkedAt} /> : 'not checked yet'}</Det>
      <Det k="Changelog">
        <a className="link upd-cl" href={r.changelog} target="_blank" rel="noreferrer noopener">
          {r.title}<Icon icon={ArrowUpRight} size="xs" />
        </a>
      </Det>
    </dl>
  );
}

/** THE ONE ACTION. An icon button with a real accessible name - which is the
 *  whole point of the change: "Update…" in a cell was one of nine mark families
 *  competing in a row, and a glyph with a name says the same thing in a square.
 *
 *  It says APPLY, not Update. The two are different actions and the page had one
 *  word for both: Update moves the pin in `main` (a PR, elsewhere), Apply makes
 *  this box run what `main` already pins - which is the only one this button can
 *  do. Ten components behind on APPLY, under a headline counting UPDATES, is what
 *  produced three refusals in a row that read like a fault.
 *
 *  When the row's recipe has more than one pin waiting, applying this one alone
 *  WILL be refused, so the button opens the GROUP instead of a request the host
 *  is certain to turn down. */
function DeployCell({ r, group, canAct, busy, onUpdate, onGroup }:
{ r: UpdateRow; group: GroupRow | null } & Omit<RowCtx, 'onChanged'>) {
  const p = r.plan;
  // `no plan` and `not deployable` are states, and the REASON is in the
  // disclosure; the cell itself says only that there is nothing to press.
  if (!p || !p.deployable || !canAct) return <span className="dim upd-noact" aria-hidden="true">-</span>;
  if (r.applyWithGroup && group?.plan) {
    const g = group.plan;
    return (
      <Button
        size="sm" iconOnly className="upd-go" onClick={() => onGroup(group)} disabled={busy}
        aria-label={`Apply ${r.title} with the rest of ${g.recipe} - ${g.members.length} components in one apply, `
          + 'because applying it alone would be refused'}
        title={busy ? 'An update is running - one at a time'
          : `${r.title} cannot be applied alone: apply all ${g.members.length} of ${g.recipe}`}
      >
        <Icon icon={Layers} size="sm" />
      </Button>
    );
  }
  return (
    <Button
      size="sm" iconOnly className="upd-go" onClick={() => onUpdate(r)} disabled={busy}
      aria-label={`Apply ${r.title}: ${p.from} to ${p.to} - a ${LEVEL_WORD[p.level]} release main already pins`}
      title={busy ? 'An update is running - one at a time' : `Apply ${r.title}: ${p.from} → ${p.to}`}
    >
      <Icon icon={CircleArrowUp} size="sm" />
    </Button>
  );
}

function Pinned({ r }: { r: UpdateRow }) {
  const c = r.discovered?.current;
  if (!c) return <span className="dim">-</span>;
  return <span className="mono upd-tag">{c.tag ?? c.identifiedAs ?? c.version ?? 'a digest'}</span>;
}

const tagOf = (image: string | null): string | null => {
  if (!image) return null;
  const at = image.indexOf('@');
  if (at >= 0) return null;
  const last = image.split('/').pop() ?? '';
  return last.includes(':') ? last.split(':').pop() ?? null : null;
};

// The three state cells. Each keeps the ONE mark that says what the thing is
// doing - a tag, a chip, a word - and hands its explanation to the disclosure.
// `drift`, `not checked` and `paused` stay in the row because they are state,
// not notes: what they MEAN is a sentence, and a sentence is what moved.
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
        <span className="upd-drift set-warn">
          <Icon icon={AlertTriangle} size="xs" />drift
        </span>
      )}
    </>
  );
}

function Available({ r }: { r: UpdateRow }) {
  const d = r.discovered;
  if (!d) return <span className="dim">not checked yet</span>;
  if (d.error) {
    return <span className="set-warn upd-err"><Icon icon={AlertTriangle} size="xs" />not checked</span>;
  }
  if (!d.latest || !d.latest.level) {
    return <span className="upd-current"><Icon icon={Check} size="sm" />up to date</span>;
  }
  const moved = !!d.latest.floating;
  return (
    <span className="upd-avail">
      <span className="mono upd-tag">{moved ? `${d.latest.tag} → ${d.latest.version ?? 'newer'}` : d.latest.tag}</span>
      <LevelBadge level={d.latest.level} />
    </span>
  );
}

const CHANNEL_WORD: Record<Channel, string> = { auto: 'auto', notify: 'notify', manual: 'manual' };

function ChannelCell({ r }: { r: UpdateRow }) {
  const eff = r.effectiveChannel;
  return (
    <>
      <span className="upd-channel" data-channel={eff ?? r.channel}>{CHANNEL_WORD[eff ?? r.channel]}</span>
      {r.paused && (
        <span className="set-warn upd-paused-h">
          <Icon icon={CirclePause} size="xs" />paused
        </span>
      )}
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
        <Icon icon={CirclePause} size="xs" />auto paused
      </span>
      <span className="set-cell-sub upd-why">
        <Ticks text={p.reason} />
        {p.since && <> · since <When iso={p.since} /></>}
        {p.requestedBy && <> · job asked by <Actor who={p.requestedBy} /></>}
      </span>
      {waiting ? (
        <span className="set-cell-sub"><Loader state="connect" size="sm" label="unpause asked - waiting for the host" /></span>
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
        {loading ? <p className="sa-working"><Loader state="load" size="sm" label="Reading the plan…" /></p>
          : error ? <PlanRefusal error={error} />
            : !plan ? (
              // The shared empty state (SYS-18). It wore the NO-ROLE block,
              // which says "you are not allowed to do this" - and nobody is
              // being refused here: there is simply nothing to deploy.
              <EmptyState
                message="No update to deploy."
                hint={<Prose text={data?.reason ?? 'The host wrote no plan for this component.'} />}
              />
            ) : (
              <>
                <PlanFacts plan={plan} age={data?.ageSeconds ?? null} />
                {phase.t === 'refused' && <PlanRefusal error={phase.error} />}
                <form className="ka-confirm" onSubmit={(e) => { e.preventDefault(); void go(); }}>
                  <p className="sa-warn">
                    <Icon icon={AlertTriangle} size="md" />
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
        <Icon icon={ArrowRight} size="md" className="upd-diff-arrow" />
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
          ? <a className="link upd-cl" href={plan.changelog} target="_blank" rel="noreferrer noopener">{plan.to.version ?? plan.to.tag}<Icon icon={ArrowUpRight} size="xs" /></a>
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
        {plan.oneWay && <><dt>One-way</dt><dd className="set-warn"><Icon icon={Lock} size="xs" />{plan.oneWayWhy}</dd></>}
        {plan.cluster && <><dt>Cluster</dt>
          <dd>context <span className="mono">{plan.cluster.context}</span> as <span className="mono">{plan.cluster.identity}</span>
            {plan.cluster.revision != null && <> · helm revision {plan.cluster.revision} is the rollback point</>}
            {' '}· only <span className="mono">{plan.recipe}</span></dd></>}
        {plan.pgMajor && <><dt>Volumes</dt>
          <dd><span className="mono">{plan.pgMajor.oldVolume}</span> ({plan.pgMajor.fromMajor}) <Icon icon={ArrowRight} size="xs" />{' '}
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
        <Icon icon={ArrowRight} size="md" className="upd-diff-arrow" />
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
          ? <a className="link upd-cl" href={own.releaseUrl} target="_blank" rel="noreferrer noopener">{own.tag} release notes<Icon icon={ArrowUpRight} size="xs" /></a>
          : <span className="dim">none linked</span>}
          {own.commits != null && <span className="set-cell-sub">{own.commits} commits{own.diffstat ? ` · ${own.diffstat}` : ''}</span>}</dd>
        <dt>CI</dt>
        <dd><span className="upd-ci"><Icon icon={Check} size="sm" />{own.ci.detail ?? 'verified green'}</span>
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
          <><dt>Updater</dt><dd className="set-warn upd-own-updater"><Icon icon={AlertTriangle} size="xs" />
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
  succeeded: 'Applied',
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
        <p className="upd-job-h"><Icon icon={AlertTriangle} size="md" />The host has no job <span className="mono">{id.slice(0, 12)}</span>.</p>
        <div className="ka-row"><Button variant="ghost" size="sm" onClick={onDismiss}>Dismiss</Button></div>
      </section>
    );
  }
  const tone = job ? STATE_TONE[job.state] : 'busy';
  return (
    <section ref={ref} className="upd-job" data-tone={tone} aria-label="Update job" aria-live="polite">
      <header className="upd-job-head">
        <p className="upd-job-h">
          {!job || !done ? <Loader state="work" size="sm" announce={false} /> : <JobGlyph state={job.state} />}
          <span>{job ? STATE_WORD[job.state] : 'Asking the host…'}</span>
          {job && <span className="mono upd-job-what">{job.component}{job.to ? ` → ${job.to.version ?? job.to.image}` : ''}</span>}
          {/* A group job: `component` is the recipe, so say which components it
              is moving - otherwise the panel names a `just` target and nothing
              about what is being replaced. */}
          {job && (job.members?.length ?? 0) > 0 && (
            <span className="set-cell-sub">{job.members!.join(', ')}</span>
          )}
        </p>
        {done && <Button variant="ghost" size="sm" onClick={onDismiss}>Dismiss</Button>}
      </header>
      {lost && !done && (
        <p className="set-note upd-lost" role="status">
          <Loader state="connect" size="sm" announce={false} /> Reconnecting - {lost.why}. The job runs on the host whatever this tab does;
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

/** THE SLOT AT REST (D3). It exists so that the rail's box is the same size with
 *  and without a job - that is the whole no-shift guarantee - and it carries a
 *  fact rather than reserving blank space. Reserved emptiness is a worse answer
 *  than a reserved fact, and the last job is the one the History block below makes
 *  you scroll for. One line: what, how it ended, when, who asked. */
function RestingJob({ d }: { d: UpdatesStatus | null }) {
  const last = d?.history?.[0] ?? null;
  return (
    <section className="upd-job upd-job-rest" data-tone="rest" aria-label="Update activity">
      <p className="upd-job-h">
        <Icon icon={CircleDashed} size="md" />
        <span>Nothing is running</span>
      </p>
      {last ? (
        <p className="set-cell-sub upd-rest-last">
          Last: <b>{last.component}</b>{' '}
          <span className="upd-result" data-tone={STATE_TONE[last.state]}>
            <JobGlyph state={last.state} />{HIST_WORD[last.state]}
          </span>{' '}
          <When iso={last.endedAt ?? last.requestedAt} /> · asked by <Actor who={last.requestedBy} />
        </p>
      ) : (
        <p className="set-cell-sub">No update has run from here yet.</p>
      )}
    </section>
  );
}

const secs = (a: string, b: string) => {
  const s = Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000));
  return s >= 90 ? `${Math.round(s / 60)} min` : `${s} s`;
};

function StepGlyph({ state }: { state: JobStep['state'] }) {
  if (state === 'running') return <Loader state="work" size="sm" label="running" labelHidden announce={false} className="upd-step-g" />;
  if (state === 'ok') return <Icon icon={Check} size="sm" className="upd-step-g" aria-label="done" />;
  if (state === 'failed') return <Icon icon={X} size="sm" className="upd-step-g" aria-label="failed" />;
  if (state === 'skipped') return <Icon icon={Minus} size="sm" className="upd-step-g" aria-label="skipped" />;
  return <Icon icon={CircleDashed} size="sm" className="upd-step-g" aria-label="pending" />;
}

function JobGlyph({ state }: { state: JobState }) {
  if (state === 'succeeded') return <Icon icon={Check} size="md" />;
  if (state === 'failed') return <Icon icon={X} size="md" />;
  if (state === 'rolled_back') return <Icon icon={RotateCcw} size="md" />;
  return <Icon icon={AlertTriangle} size="md" />;
}

// ── history ──────────────────────────────────────────────────────────────────

const HIST_WORD: Record<JobState, string> = {
  queued: 'queued', running: 'running', succeeded: 'applied', rolled_back: 'rolled back', aborted: 'aborted',
  failed: 'failed', refused: 'refused',
};

function History({ d }: { d: UpdatesStatus | null }) {
  const h: HistoryEntry[] = d?.history ?? [];
  if (h.length === 0) {
    return <p className="set-empty">No update has run from here yet. Each one leaves a line in the host’s{' '}
      <span className="mono">~/.local/state/bothy/updates/history.jsonl</span>.</p>;
  }
  return (
    <div className="tbl-wrap scroll-shade set-tbl">
      <table className="tbl as-cards upd-tbl upd-hist">
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
              <td data-label="Component"><b>{e.component}</b>
                {(e.members?.length ?? 0) > 0
                  && <span className="set-cell-sub">{e.members!.join(', ')}</span>}</td>
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
      {/* Five definitions that were five paragraphs (D2). Each keeps the clause
          that defines the word; what each one EXCLUDES, and why, is behind the
          glyph. The counts stay on the surface - they are the data. */}
      <div className="kv"><div className="kv-k">auto</div><div className="kv-v">
        Patch releases only, applied in the night window.
        <InfoHint label="What the auto channel will not do" side="top" align="start">
          <p>
            A minor of an auto component is only <b>notified</b>; a major is <b>manual</b>. Only stateless and
            time-series components may be auto - the catalog cannot widen that.
          </p>
        </InfoHint>
        {d && <span className="set-note">{count('auto')} components.</span>}
      </div></div>
      <div className="kv"><div className="kv-k">notify</div><div className="kv-v">
        Shown here with its step, and applied by a person.
        <InfoHint label="Which components are notify" side="top" align="start">
          <p>Grafana, Traefik, Bothy itself and the cluster add-ons.</p>
        </InfoHint>
        {d && <span className="set-note">{count('notify')} components.</span>}
      </div></div>
      <div className="kv"><div className="kv-k">manual</div><div className="kv-v">
        Never offered as one click.
        <InfoHint label="Which components are manual only" side="top" align="start">
          <p>
            Keycloak, both oauth2-proxies, the Docker socket proxies and Postgres, and <b>any</b> major of anything.
          </p>
        </InfoHint>
        {d && <span className="set-note">{count('manual')} components.</span>}
      </div></div>
      <div className="kv"><div className="kv-k">Night window</div><div className="kv-v">
        {p ? <>{p.windowStart}–{p.windowEnd}</> : '03:30–05:00'} local time, at most{' '}
        {p?.maxAutoPerNight ?? 1} automatic update a night.
        <InfoHint label="Every gate the night job has to pass" side="top" align="start">
          <p>
            It runs only if that night&rsquo;s <span className="mono">{p?.requireBackup ?? 'stacks-backup.service'}</span>{' '}
            succeeded and the component itself was healthy, its canaries green. It stops at the first failure.
          </p>
          <p>
            A rollback or a failed verify pauses auto for that component until an operator clears it
            (<b>Unpause</b> on its row, or <span className="mono">just update-unpause &lt;component&gt;</span>). A
            night the box slept through is skipped, never caught up.
          </p>
        </InfoHint>
        <LastNight d={d} />
      </div></div>
      <div className="kv"><div className="kv-k">One-way</div><div className="kv-v">
        <span className="upd-oneway"><Icon icon={Lock} size="xs" />one-way</span>{' '}
        cannot be rolled back by re-pinning.
        <InfoHint label="What one-way means for a rollback" side="top" align="start">
          <p>
            The component&rsquo;s first start on a new version migrates data the old version cannot read, so rolling
            back is a restore, not a re-pin. Take a backup first.
          </p>
        </InfoHint>
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
  // What the updater will not do, and what to do instead. A row whose only
  // obstacle is that its recipe has several pins waiting is NOT by hand any more -
  // its group is the action, so it would be wrong to list it here.
  const manual = (d?.components ?? []).filter((r) => (r.level || r.discovered?.drift) && !r.plan?.deployable
    && !r.applyWithGroup);
  return (
    <>
      <div className="kv-list">
        {/* THE WORDIEST BLOCK ON THE WORDIEST PAGE (D2). Six label/value pairs of
            running prose, about 420 words, every one of them true and none of them
            the thing somebody opening Settings > Updates came to find out. Each
            keeps the sentence that answers its own label and hands the rest to its
            hint - so the block is now a six-line reference you can read in a
            glance, with the reasoning one keypress away. */}
        <div className="kv"><div className="kv-k">Update, and Apply</div><div className="kv-v">
          Two different actions, and this page only does the second.
          <InfoHint label="How Update and Apply differ" side="top" align="start">
            <p>
              <b>Update</b> moves a pin in <span className="mono">main</span> - a Dependabot PR, reviewed and
              merged, which happens on GitHub, not here. <b>Apply</b> makes this box run what{' '}
              <span className="mono">main</span> already pins. The headline counts them separately for that reason.
            </p>
            <p>
              A version <span className="mono">main</span> does not pin is never offered, so git stays the only
              record of what the box should run.
            </p>
          </InfoHint>
        </div></div>
        <div className="kv"><div className="kv-k">What Apply does</div><div className="kv-v">
          Deploys what <span className="mono">main</span> already pins and is not running yet - nothing else.
          <InfoHint label="What Apply does, step by step" side="top" align="start">
            <p>
              The host re-checks the plan, runs the pre-flight, takes a snapshot, pulls, runs the component&rsquo;s
              recipe, then checks the component&rsquo;s canaries <b>by their bodies</b>. Any failure puts the old
              image back.
            </p>
            <p>
              It runs as a host job (<span className="mono">bothy-updater.service</span>), not in bothy-ops: this
              page only drops one request in a spool. It keeps running if you close the tab.
            </p>
          </InfoHint>
        </div></div>
        <div className="kv"><div className="kv-k">Bothy itself</div><div className="kv-v">
          Deploys the newest <b>release tag</b> CI marked green, never main&rsquo;s tip.
          <InfoHint label="How Bothy updates itself" side="top" align="start">
            <p>
              <span className="mono">release.yml</span> tags only a commit whose CI passed on{' '}
              <span className="mono">main</span>. The new images are built before anything running changes; a
              rollback timer is armed before the checkout moves, and puts the previous commit and images back
              unless verify passes.
            </p>
            <p>
              Open tabs are told to reload when the page they loaded is no longer the one being served. The same
              path runs from a shell: <span className="mono">bothy upgrade</span>.
            </p>
          </InfoHint>
        </div></div>
        <div className="kv"><div className="kv-k">Getting a newer version</div><div className="kv-v">
          Merge its Dependabot PR, then on the box <Cmd>git pull --ff-only</Cmd> and <Cmd>just updates-discover</Cmd>.
        </div></div>
        <div className="kv"><div className="kv-k">Several pins in one recipe</div><div className="kv-v">
          The <b>group</b> above applies the whole recipe at once.
          <InfoHint label="Why one component of a recipe cannot be applied alone" side="top" align="start">
            <p>
              A <span className="mono">just up-&lt;recipe&gt;</span> is one{' '}
              <span className="mono">docker compose up</span>, so the host refuses to apply one component while
              another service of the same project also has a merged pin waiting: it would recreate that one too,
              with no snapshot of it.
            </p>
            <p>
              The group takes every member&rsquo;s own snapshot first, needs the strictest confirmation any member
              needs, and rolls back all or nothing. Never automatically. From a shell,{' '}
              <span className="mono">just update-groups</span> prints what each recipe would apply, and why one is
              refused.
            </p>
          </InfoHint>
        </div></div>
        <div className="kv"><div className="kv-k">From a shell</div><div className="kv-v">
          <Cmd>systemctl status bothy-updater.service</Cmd>
          <InfoHint label="Where the records are, without this page" side="top" align="start">
            <p>
              Recovery never needs this page: the job&rsquo;s status, history and audit lines live under{' '}
              <span className="mono">~/.local/state/bothy/updates/</span>, and every snapshot under{' '}
              <span className="mono">~/backups/pre-update/</span>.
            </p>
          </InfoHint>
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
