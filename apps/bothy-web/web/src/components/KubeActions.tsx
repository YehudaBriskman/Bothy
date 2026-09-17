// Cluster workload actions - the row control and the dialog it opens.
//
// The cluster twin of ServiceActions.tsx: a node discovered from Kubernetes has
// no container for bothy-ops' container verbs to act on, but it has a namespace and a
// deployment, and bothy-ops' kube verbs act on those. ActionCell hands such a node here,
// so every surface that already draws the container control (the Services
// table, a service's detail header) draws this one for cluster workloads with
// no edit of its own.
//
// Three tabs, because the three kinds of thing here have different rhythms:
// Actions change something and confirm first; Events and Logs only read, load on
// open, and never ask. The confirm step follows the catalog's level exactly:
//
//   click       a second step that names the object and the consequence
//   type-name   the same, plus typing the deployment's name - which the service
//               checks too, so the level means the same thing from curl
//
// WHAT THE INTERFACE HIDES IS NEVER WHAT THE API ENFORCES - see lib/kube-actions.ts.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Boxes, CirclePlay, CircleStop, RefreshCw, RotateCw, Scaling, Trash2 } from 'lucide-react';
import {
  allowedFor, confirmSatisfied, deleteCompletedPods, followLogs, FOLLOW_SECONDS, kubeEvents, kubeLogs,
  kubeRefusalOf, kubeTargetOf, rolloutRestart, scale, SCALE_MAX, SCALE_MIN, specOf,
  type DeleteCompletedResult, type KubeActionId, type KubeEvent, type KubeRefusal, type KubeTarget,
  type RestartResult, type ScaleResult,
} from '../lib/kube-actions';
import { useOperator } from '../lib/session';
import { usePortal } from '../lib/data';
import type { PortalNode } from '../lib/discover';
import type { Me } from '../lib/me';
import { StatusIcon } from '../lib/icons';
import { Dialog } from './ui/Dialog';
import { Tabs } from './Tabs';
import './KubeActions.css';

const CHANGE_ICON: Record<'rollout-restart' | 'scale' | 'delete-completed-pods', typeof RotateCw> = {
  'rollout-restart': RotateCw,
  scale: Scaling,
  'delete-completed-pods': Trash2,
};
const CHANGES = ['rollout-restart', 'scale', 'delete-completed-pods'] as const;
type Change = (typeof CHANGES)[number];

/** Roles for DRAWING. The dev override matches lib/session.ts's key. */
function useKubeRoles(): { roles: string[]; loading: boolean; me: Me | null } {
  const { me, loading } = useOperator();
  if (import.meta.env.DEV) {
    let raw: string | null = null;
    try { raw = localStorage.getItem('bothy-dev-roles'); } catch { raw = null; }
    if (raw !== null) return { roles: raw.split(',').map((r) => r.trim()), loading: false, me };
  }
  return { roles: me?.roles ?? [], loading, me };
}

/** The row cell for a cluster workload. Nothing at all outside bothy-ops' kube scope. */
export function KubeActionCell({ node }: { node: PortalNode }) {
  const [open, setOpen] = useState(false);
  const target = kubeTargetOf(node);
  if (!target) return null;
  const label = `Cluster actions for ${target.namespace}/${target.deployment}`;
  return (
    <>
      <button
        type="button"
        className="svc-act-btn"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        data-open={open ? 'true' : 'false'}
        aria-label={label}
        title={label}
      >
        <Boxes size={15} aria-hidden="true" />
      </button>
      {open && <KubeDialog node={node} target={target} onClose={() => setOpen(false)} />}
    </>
  );
}

type Tab = 'actions' | 'events' | 'logs';

function KubeDialog({ node, target, onClose }: { node: PortalNode; target: KubeTarget; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('actions');
  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={<span className="sa-title">Cluster <span className="mono">{target.namespace}/{target.deployment}</span></span>}
      description="Restart, scale, events and logs for this deployment. Anything else is kubectl."
      headerAside={<StatusIcon status={node.status} showLabel title={node.desc || node.status} />}
    >
      <div className="ka-body">
        <Tabs
          label="Cluster actions"
          value={tab}
          onChange={(k) => setTab(k as Tab)}
          tabs={[{ key: 'actions', label: 'Actions' }, { key: 'events', label: 'Events' }, { key: 'logs', label: 'Logs' }]}
        />
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="ka-panel">
          {tab === 'actions' && <ActionsTab target={target} detail={node.desc} />}
          {tab === 'events' && <EventsTab target={target} />}
          {tab === 'logs' && <LogsTab target={target} />}
        </div>
      </div>
    </Dialog>
  );
}

// ── actions ─────────────────────────────────────────────────────────────────

type Phase =
  | { t: 'choose' }
  | { t: 'confirm'; id: Change }
  | { t: 'working'; id: Change }
  | { t: 'done'; id: Change; line: string; sub?: string }
  | { t: 'failed'; id: Change; refusal: KubeRefusal };

function ActionsTab({ target, detail }: { target: KubeTarget; detail: string }) {
  const { roles, loading } = useKubeRoles();
  const { refresh } = usePortal();
  const [phase, setPhase] = useState<Phase>({ t: 'choose' });
  const [typed, setTyped] = useState('');
  const [replicas, setReplicas] = useState(1);
  const firing = useRef(false);

  const whatOf = (id: Change) => (id === 'delete-completed-pods' ? target.namespace : target.deployment);

  const run = useCallback(async (id: Change) => {
    if (firing.current) return;
    firing.current = true;
    setPhase({ t: 'working', id });
    try {
      if (id === 'rollout-restart') {
        const r: RestartResult = await rolloutRestart(target);
        setPhase({ t: 'done', id, line: `Rollout restarted for ${target.deployment}.`, sub: `Stamped ${r.restartedAt}. Pods are replaced one at a time; the row reads Starting until they are ready.` });
      } else if (id === 'scale') {
        const r: ScaleResult = await scale(target, replicas, typed);
        setPhase({ t: 'done', id, line: `Scaled ${target.deployment}.`, sub: `${r.from} -> ${r.to} replicas.` });
      } else {
        const r: DeleteCompletedResult = await deleteCompletedPods(target.namespace);
        setPhase({
          t: 'done', id,
          line: r.deleted.length ? `Deleted ${r.deleted.length} completed pod${r.deleted.length === 1 ? '' : 's'} in ${target.namespace}.` : `No completed pods in ${target.namespace}.`,
          sub: r.deleted.length ? r.deleted.join(', ') : 'Nothing was changed.',
        });
      }
      refresh();
    } catch (e) {
      setPhase({ t: 'failed', id, refusal: kubeRefusalOf(e, specOf(id), whatOf(id)) });
    } finally {
      firing.current = false;
      setTyped('');
    }
  }, [target, replicas, typed, refresh]);

  if (phase.t === 'confirm') {
    const spec = specOf(phase.id);
    const what = whatOf(phase.id);
    const ready = confirmSatisfied(spec.confirm, typed, what) && (phase.id !== 'scale' || (replicas >= SCALE_MIN && replicas <= SCALE_MAX));
    return (
      <form className="ka-confirm" onSubmit={(e) => { e.preventDefault(); if (ready) void run(phase.id); }}>
        <p className="sa-warn">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{consequence(phase.id, target, replicas)}</span>
        </p>
        {phase.id === 'scale' && (
          <label className="ka-field">
            <span className="ka-label">Replicas <span className="dim">({SCALE_MIN} to {SCALE_MAX})</span></span>
            <input
              className="ka-input mono" type="number" min={SCALE_MIN} max={SCALE_MAX} step={1} value={replicas}
              onChange={(e) => setReplicas(Math.max(SCALE_MIN, Math.min(SCALE_MAX, Number(e.target.value) || 0)))}
            />
            {detail && <span className="ka-hint">Now: {detail}</span>}
          </label>
        )}
        {spec.confirm === 'type-name' && (
          <label className="ka-field">
            <span className="ka-label">Type <span className="mono">{what}</span> to confirm</span>
            <input
              className="ka-input mono" autoComplete="off" spellCheck={false} value={typed}
              onChange={(e) => setTyped(e.target.value)} aria-invalid={typed.length > 0 && typed !== what}
            />
          </label>
        )}
        <div className="ka-row">
          <button type="button" className="btn ghost" onClick={() => { setTyped(''); setPhase({ t: 'choose' }); }}>Leave it alone</button>
          <button type="submit" className="btn sa-go" disabled={!ready}>
            {phase.id === 'scale' ? `Scale ${what} to ${replicas}` : `${spec.title} ${phase.id === 'delete-completed-pods' ? 'in' : 'of'} ${what}`}
          </button>
        </div>
      </form>
    );
  }

  if (phase.t === 'working') {
    return <p className="sa-working"><span className="sa-spin" />{specOf(phase.id).title}…</p>;
  }

  if (phase.t === 'done' || phase.t === 'failed') {
    return (
      <div className="sa-outcome" data-ok={phase.t === 'done' ? 'true' : 'false'} role="status" aria-live="polite">
        <p className="sa-outcome-h">{phase.t === 'done' ? phase.line : phase.refusal.title}</p>
        <p className="sa-note">{phase.t === 'done' ? phase.sub : phase.refusal.detail}</p>
        <div className="ka-row"><button type="button" className="btn ghost" onClick={() => setPhase({ t: 'choose' })}>Back</button></div>
      </div>
    );
  }

  const canChange = CHANGES.some((id) => allowedFor(roles, specOf(id)));
  return (
    <>
      {!loading && !canChange && (
        <div className="sa-norole">
          <p className="sa-norole-h">These are read-only for you.</p>
          <p className="sa-note">Changing cluster workloads needs the operator role. Events and Logs need viewer.</p>
        </div>
      )}
      <ul className="sa-verbs">
        {CHANGES.map((id) => {
          const spec = specOf(id);
          const Icon = CHANGE_ICON[id];
          const enabled = allowedFor(roles, spec);
          return (
            <li key={id}>
              <button
                type="button" className="sa-verb" aria-disabled={enabled ? undefined : true}
                onClick={() => { if (enabled) { setTyped(''); setPhase({ t: 'confirm', id }); } }}
              >
                <Icon size={16} className="sa-verb-ico" aria-hidden="true" />
                <span className="sa-verb-text">
                  <span className="sa-verb-name">
                    {spec.title}
                    {spec.confirm === 'type-name' && <span className="ka-flag">Type to confirm</span>}
                    {id === 'delete-completed-pods' && <span className="ka-flag">Whole namespace</span>}
                  </span>
                  <span className="sa-verb-why">{spec.meaning}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function consequence(id: Change, t: KubeTarget, replicas: number): string {
  if (id === 'rollout-restart') return `Every pod of ${t.deployment} in ${t.namespace} is replaced. While new pods start, requests may fail if there is only one replica.`;
  if (id === 'scale') return replicas === 0
    ? `${t.deployment} in ${t.namespace} stops entirely. It stays at 0 until somebody scales it back.`
    : `${t.deployment} in ${t.namespace} runs ${replicas} pod${replicas === 1 ? '' : 's'}. The next deploy of its manifest may set this back.`;
  return `Every pod in ${t.namespace} whose phase is Succeeded is deleted, with its logs. Running pods are not touched.`;
}

// ── events ──────────────────────────────────────────────────────────────────

function EventsTab({ target }: { target: KubeTarget }) {
  const [events, setEvents] = useState<KubeEvent[] | null>(null);
  const [refusal, setRefusal] = useState<KubeRefusal | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setRefusal(null);
    kubeEvents(target)
      .then((r) => { if (live) setEvents(r.events); })
      .catch((e) => { if (live) setRefusal(kubeRefusalOf(e, specOf('events'), target.deployment)); });
    return () => { live = false; };
  // Keyed on the STRINGS: `target` is rebuilt on every 10s poll, and keying on
  // the object would refetch - and wipe a live follow - each time.
  }, [target.namespace, target.deployment, nonce]);

  return (
    <div className="ka-stack">
      <div className="ka-row ka-row-between">
        <p className="sa-note">{events ? `${events.length} event${events.length === 1 ? '' : 's'}, newest first.` : 'Reading events…'}</p>
        <button type="button" className="btn ghost ka-small" onClick={() => setNonce((n) => n + 1)}>
          <RefreshCw size={14} aria-hidden="true" /> Refresh
        </button>
      </div>
      {refusal && <Refused r={refusal} />}
      {events && events.length === 0 && <p className="sa-note">The cluster has nothing recent to say about {target.deployment}. Events expire after an hour.</p>}
      {events && events.length > 0 && (
        <ol className="ka-events">
          {events.map((ev, i) => (
            <li key={`${ev.object}-${ev.reason}-${i}`} className="ka-event" data-type={ev.type === 'Warning' ? 'warn' : 'normal'}>
              <span className="ka-ev-type">{ev.type === 'Warning' ? <AlertTriangle size={13} aria-hidden="true" /> : null}{ev.type}</span>
              <span className="ka-ev-main">
                <span className="ka-ev-head"><strong>{ev.reason}</strong> <span className="mono dim">{ev.object}</span>{ev.count > 1 && <span className="dim"> ×{ev.count}</span>}</span>
                <span className="ka-ev-msg">{ev.message}</span>
              </span>
              <time className="ka-ev-time dim" dateTime={ev.lastSeen} title={ev.lastSeen}>{ago(ev.lastSeen)}</time>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return iso;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

// ── logs ────────────────────────────────────────────────────────────────────

const KEEP_LINES = 2000;

function LogsTab({ target }: { target: KubeTarget }) {
  const [lines, setLines] = useState<string[]>([]);
  const [source, setSource] = useState<string>('');
  const [refusal, setRefusal] = useState<KubeRefusal | null>(null);
  const [loading, setLoading] = useState(true);
  const [following, setFollowing] = useState(false);
  const [ended, setEnded] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const stop = useRef<(() => void) | null>(null);
  const box = useRef<HTMLPreElement>(null);
  const spec = useMemo(() => specOf('logs' as KubeActionId), []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setRefusal(null);
    kubeLogs(target, 200)
      .then((r) => { if (live) { setLines(r.lines); setSource(`${r.pod} / ${r.container}`); } })
      .catch((e) => { if (live) setRefusal(kubeRefusalOf(e, spec, target.deployment)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [target.namespace, target.deployment, nonce, spec]);

  // Stop a follow when the tab or dialog goes away - an abandoned EventSource
  // would hold the stream until its deadline for nobody.
  useEffect(() => () => stop.current?.(), []);

  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const follow = () => {
    setEnded(null);
    setRefusal(null);
    setFollowing(true);
    setLines([]);
    stop.current = followLogs(target, 50, FOLLOW_SECONDS, {
      onMeta: (m) => setSource(`${m.pod} / ${m.container}`),
      onLine: (l) => setLines((prev) => (prev.length >= KEEP_LINES ? [...prev.slice(-KEEP_LINES + 1), l] : [...prev, l])),
      onEnd: (why) => {
        setFollowing(false);
        setEnded(why.reason === 'deadline'
          ? `Stopped following after ${FOLLOW_SECONDS / 60} minutes. Follow again to continue.`
          : 'The pod closed its log stream.');
      },
      onError: () => {
        setFollowing(false);
        // EventSource cannot say WHY. Ask the same question as a plain read,
        // which answers in words.
        kubeLogs(target, 1).then(
          () => setEnded('The live stream dropped. The cluster tier is answering, so following again should work.'),
          (e) => setRefusal(kubeRefusalOf(e, spec, target.deployment)),
        );
      },
    });
  };

  const halt = () => { stop.current?.(); stop.current = null; setFollowing(false); setEnded('Stopped.'); };

  return (
    <div className="ka-stack">
      <div className="ka-row ka-row-between">
        <p className="sa-note">
          {following ? <><span className="ka-live" aria-hidden="true" /> Following </> : loading ? 'Reading logs… ' : 'Last lines from '}
          {source && <span className="mono">{source}</span>}
        </p>
        <div className="ka-row">
          {following ? (
            <button type="button" className="btn ghost ka-small" onClick={halt}><CircleStop size={14} aria-hidden="true" /> Stop</button>
          ) : (
            <>
              <button type="button" className="btn ghost ka-small" onClick={() => setNonce((n) => n + 1)}><RefreshCw size={14} aria-hidden="true" /> Refresh</button>
              <button type="button" className="btn ka-small" onClick={follow}><CirclePlay size={14} aria-hidden="true" /> Follow</button>
            </>
          )}
        </div>
      </div>
      {refusal && <Refused r={refusal} />}
      {ended && <p className="sa-note" role="status">{ended}</p>}
      <pre className="ka-log mono" ref={box} tabIndex={0} aria-label={`Logs of ${target.deployment}`}>
        {lines.length ? lines.join('\n') : (loading ? '' : 'No output.')}
      </pre>
    </div>
  );
}

function Refused({ r }: { r: KubeRefusal }) {
  return (
    <div className="sa-outcome" data-ok="false">
      <p className="sa-outcome-h">{r.title}</p>
      <p className="sa-note">{r.detail}</p>
    </div>
  );
}
