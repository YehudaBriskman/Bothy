// Cluster workload actions - the row control and the dialog it opens.
//
// The cluster twin of ServiceActions.tsx: a node discovered from Kubernetes has
// no container for bothy-ops' container verbs to act on, but it has a namespace
// and a deployment, and bothy-ops' kube verbs act on those. ActionCell hands such
// a node here, and the Cluster page's Workloads tab opens the same dialog.
//
// Five tabs, because the kinds of thing here have different rhythms: Actions
// change something and confirm first (components/KubeConfirm.tsx); History,
// Pods, Events and Logs read, load on open, and only confirm when a row offers a
// change (roll back to a revision, delete a pod).
//
// Every action, its title, its meaning and its confirm level come from the
// catalog the service serves (GET /-/api/kube/catalog) - nothing here is a copy.
//
// WHAT THE INTERFACE HIDES IS NEVER WHAT THE API ENFORCES - see lib/kube-actions.ts.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle, Boxes, CirclePause, CirclePlay, CircleStop, History, Image as ImageIcon, RefreshCw, RotateCcw,
  RotateCw, Scaling, Trash2,
} from 'lucide-react';
import {
  allowedFor, boundsOf, findSpec, followLogs, FOLLOW_SECONDS, kubeLogs, kubeRefusalOf, kubeTargetOf,
  type DeletePodResult, type DeleteCompletedResult, type DeploymentsResult, type EventsResult, type HistoryResult, type KubeActionSpec,
  type KubeCatalog, type KubeEvent, type KubeRefusal, type KubeTarget, type PauseResult, type PodsResult,
  type RestartResult, type RollbackResult, type RolloutStatusResult, type ScaleResult, type SetImageResult,
} from '../lib/kube-actions';
import { useKubeCatalog, useKubeRead, useKubeRoles } from '../lib/kube-catalog';
import { ago, gate, imageAllowed, podStatus, shortImage } from '../lib/cluster';
import { usePortal } from '../lib/data';
import type { PortalNode } from '../lib/discover';
import { StatusIcon } from '../lib/icons';
import { Dialog } from './ui/Dialog';
import { Tabs } from './Tabs';
import { ConfirmPanel } from './KubeConfirm';
import './KubeActions.css';
import { Button } from './ui/Button';

/** The row cell for a cluster workload. Nothing at all outside bothy-ops' kube scope. */
export function KubeActionCell({ node }: { node: PortalNode }) {
  const [open, setOpen] = useState(false);
  const target = kubeTargetOf(node);
  const { refresh } = usePortal();
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
      {open && (
        <KubeDialog
          target={target}
          onClose={() => setOpen(false)}
          onChanged={refresh}
          aside={<StatusIcon status={node.status} showLabel title={node.desc || node.status} />}
        />
      )}
    </>
  );
}

export type KubeDialogTab = 'actions' | 'history' | 'pods' | 'events' | 'logs';

export function KubeDialog({ target, onClose, onChanged, aside, initialTab = 'actions', initialPod }: {
  target: KubeTarget;
  onClose: () => void;
  /** After any successful change - the caller re-reads whatever it draws. */
  onChanged?: () => void;
  aside?: ReactNode;
  initialTab?: KubeDialogTab;
  /** For initialTab 'logs': which pod to open on. */
  initialPod?: string;
}) {
  const [tab, setTab] = useState<KubeDialogTab>(initialTab);
  const [logPod, setLogPod] = useState<string | undefined>(initialPod);
  const { catalog, refusal } = useKubeCatalog();
  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={<span className="sa-title">Cluster <span className="mono">{target.namespace}/{target.deployment}</span></span>}
      description="Roll out, roll back, scale, pods, events and logs for this deployment. Anything else is kubectl."
      headerAside={aside}
    >
      <div className="ka-body">
        <Tabs
          label="Cluster actions"
          value={tab}
          onChange={(k) => setTab(k as KubeDialogTab)}
          tabs={[
            { key: 'actions', label: 'Actions' }, { key: 'history', label: 'History' }, { key: 'pods', label: 'Pods' },
            { key: 'events', label: 'Events' }, { key: 'logs', label: 'Logs' },
          ]}
        />
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="ka-panel">
          {!catalog && refusal && <Refused r={refusal} />}
          {!catalog && !refusal && <p className="sa-working"><span className="sa-spin" />Reading what this tier can do…</p>}
          {catalog && tab === 'actions' && <ActionsTab catalog={catalog} target={target} onChanged={onChanged} />}
          {catalog && tab === 'history' && <HistoryTab catalog={catalog} target={target} onChanged={onChanged} />}
          {catalog && tab === 'pods' && (
            <PodsTab catalog={catalog} target={target} onChanged={onChanged} onLogs={(p) => { setLogPod(p); setTab('logs'); }} />
          )}
          {catalog && tab === 'events' && <EventsTab target={target} />}
          {catalog && tab === 'logs' && <LogsTab target={target} initialPod={logPod} />}
        </div>
      </div>
    </Dialog>
  );
}

// ── actions ─────────────────────────────────────────────────────────────────

type Change = 'rollout-restart' | 'scale' | 'pause' | 'resume' | 'set-image' | 'delete-completed-pods';
const CHANGE_ICON: Record<Change, typeof RotateCw> = {
  'rollout-restart': RotateCw, scale: Scaling, pause: CirclePause, resume: CirclePlay, 'set-image': ImageIcon,
  'delete-completed-pods': Trash2,
};

function ActionsTab({ catalog, target, onChanged }: { catalog: KubeCatalog; target: KubeTarget; onChanged?: () => void }) {
  const { roles, loading } = useKubeRoles();
  const [open, setOpen] = useState<Change | null>(null);
  const status = useKubeRead<RolloutStatusResult>(findSpec(catalog, 'rollout-status') ? 'rollout-status' : null,
    { namespace: target.namespace, deployment: target.deployment }, 10_000);
  const [replicas, setReplicas] = useState(1);
  const [container, setContainer] = useState('');
  const [image, setImage] = useState('');
  // The TEMPLATE's containers, from the deployment list - not from its pods,
  // which a deployment scaled to 0 does not have.
  const deps = useKubeRead<DeploymentsResult>(open === 'set-image' ? 'deployments' : null, { namespace: target.namespace }, 0);

  const paused = status.data?.paused ?? false;
  const changes: Change[] = ['rollout-restart', 'scale', paused ? 'resume' : 'pause', 'set-image', 'delete-completed-pods'];
  const specs = changes.map((id) => [id, findSpec(catalog, id)] as const).filter((x): x is readonly [Change, KubeActionSpec] => !!x[1]);

  const images = useMemo(() => deps.data?.deployments.find((d) => d.name === target.deployment)?.images ?? [], [deps.data, target.deployment]);
  const containers = images.map((i) => i.container);
  const currentImage = images.find((i) => i.container === (container || containers[0]))?.image;

  const done = () => { status.reload(); onChanged?.(); };

  if (open) {
    const spec = findSpec(catalog, open)!;
    const back = () => setOpen(null);
    const req: Record<string, unknown> = open === 'delete-completed-pods'
      ? { namespace: target.namespace }
      : { namespace: target.namespace, deployment: target.deployment };
    if (open === 'scale') {
      const { min, max } = boundsOf(spec, 'replicas');
      return (
        <ConfirmPanel
          spec={spec} req={{ ...req, replicas }} what={target.deployment} onBack={back} onDone={done}
          goLabel={`Scale ${target.deployment} to ${replicas}`}
          consequence={replicas === 0
            ? `${target.deployment} in ${target.namespace} stops entirely. It stays at 0 until somebody scales it back.`
            : `${target.deployment} in ${target.namespace} runs ${replicas} pod${replicas === 1 ? '' : 's'}. The next deploy of its manifest may set this back.`}
          fields={(
            <label className="ka-field">
              <span className="ka-label">Replicas <span className="dim">({min} to {max})</span></span>
              <input
                className="ka-input mono" type="number" min={min} max={max} step={1} value={replicas}
                onChange={(e) => setReplicas(Math.max(min, Math.min(max, Number(e.target.value) || 0)))}
              />
              {status.data && <span className="ka-hint">Now: {status.data.readyReplicas}/{status.data.replicas} ready</span>}
            </label>
          )}
          describe={(r: ScaleResult) => ({ line: `Scaled ${target.deployment}.`, sub: `${r.from} -> ${r.to} replicas.` })}
        />
      );
    }
    if (open === 'set-image') {
      const c = container || containers[0] || '';
      const ok = !!c && imageAllowed(catalog, image);
      return (
        <ConfirmPanel
          spec={spec} req={{ ...req, container: c, image }} what={target.deployment} onBack={back} onDone={done} valid={ok}
          goLabel={`Set ${c || 'container'} image`}
          consequence={`Every pod of ${target.deployment} is replaced with one running the new image. Rolling back is History -> Roll back.`}
          fields={(
            <>
              <label className="ka-field">
                <span className="ka-label">Container</span>
                <select className="ka-input mono" value={c} onChange={(e) => setContainer(e.target.value)}>
                  {containers.length === 0 && <option value="">reading…</option>}
                  {containers.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                {currentImage && <span className="ka-hint">Now: <span className="mono">{currentImage}</span></span>}
              </label>
              <label className="ka-field">
                <span className="ka-label">Image <span className="dim">({catalog.imageRegistries.join(' or ')} only, with a tag)</span></span>
                <input
                  className="ka-input ka-wide mono" autoComplete="off" spellCheck={false} value={image}
                  placeholder={currentImage ?? 'thales/backend:0.1.8'}
                  onChange={(e) => setImage(e.target.value.trim())} aria-invalid={image.length > 0 && !imageAllowed(catalog, image)}
                />
                {image.length > 0 && !imageAllowed(catalog, image) && (
                  <span className="ka-hint ka-bad">Not an image reference from {catalog.imageRegistries.join(' or ')} with a tag - the service would refuse it.</span>
                )}
              </label>
            </>
          )}
          describe={(r: SetImageResult) => ({ line: `${r.container} now runs ${r.to}.`, sub: `Was ${r.from}. Pods are replaced one at a time.` })}
        />
      );
    }
    return (
      <ConfirmPanel
        spec={spec} req={req} what={open === 'delete-completed-pods' ? target.namespace : target.deployment} onBack={back} onDone={done}
        consequence={consequenceOf(open, target)}
        describe={(r: never) => describeChange(open, target, r)}
      />
    );
  }

  const anyEnabled = specs.some(([, s]) => allowedFor(roles, s));
  return (
    <>
      {status.data && (
        <p className="ka-status" data-state={status.data.done ? 'up' : 'warn'} role="status">
          <span className="ka-dot" aria-hidden="true" />
          <span>{status.data.paused ? 'Paused. ' : ''}{status.data.message}</span>
          {status.data.revision != null && <span className="dim mono">rev {status.data.revision}</span>}
        </p>
      )}
      {!loading && !anyEnabled && (
        <div className="sa-norole">
          <p className="sa-norole-h">These are read-only for you.</p>
          <p className="sa-note">Changing cluster workloads needs the operator role. History, Pods, Events and Logs need viewer.</p>
        </div>
      )}
      <ul className="sa-verbs">
        {specs.map(([id, spec]) => {
          const g = gate(roles, spec);
          if (g === 'hidden' && !loading) return null;
          const Icon = CHANGE_ICON[id];
          const enabled = g === 'enabled';
          return (
            <li key={id}>
              <button
                type="button" className="sa-verb" aria-disabled={enabled ? undefined : true}
                onClick={() => { if (enabled) { setImage(''); setOpen(id); } }}
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

function consequenceOf(id: Change, t: KubeTarget): string {
  if (id === 'rollout-restart') return `Every pod of ${t.deployment} in ${t.namespace} is replaced. While new pods start, requests may fail if there is only one replica.`;
  if (id === 'pause') return `${t.deployment} stops rolling out template changes - including a set-image or a rollback - until it is resumed. Running pods are not touched.`;
  if (id === 'resume') return `${t.deployment} rolls out whatever template changes were made while it was paused.`;
  return `Every pod in ${t.namespace} whose phase is Succeeded is deleted, with its logs. Running pods are not touched.`;
}

function describeChange(id: Change, t: KubeTarget, r: unknown): { line: string; sub?: string } {
  if (id === 'rollout-restart') {
    const x = r as RestartResult;
    return { line: `Rollout restarted for ${t.deployment}.`, sub: `Stamped ${x.restartedAt}. Pods are replaced one at a time.` };
  }
  if (id === 'pause' || id === 'resume') {
    const x = r as PauseResult;
    return { line: x.to ? `${t.deployment} is paused.` : `${t.deployment} is rolling out again.`, sub: x.from === x.to ? 'It already was - nothing changed.' : undefined };
  }
  const x = r as DeleteCompletedResult;
  return {
    line: x.deleted.length ? `Deleted ${x.deleted.length} completed pod${x.deleted.length === 1 ? '' : 's'} in ${t.namespace}.` : `No completed pods in ${t.namespace}.`,
    sub: x.deleted.length ? x.deleted.join(', ') : 'Nothing was changed.',
  };
}

// ── history ─────────────────────────────────────────────────────────────────

function HistoryTab({ catalog, target, onChanged }: { catalog: KubeCatalog; target: KubeTarget; onChanged?: () => void }) {
  const { roles } = useKubeRoles();
  const h = useKubeRead<HistoryResult>('rollout-history', { namespace: target.namespace, deployment: target.deployment }, 0);
  const [rollTo, setRollTo] = useState<number | null>(null);
  const spec = findSpec(catalog, 'rollback-to-revision');
  const g = gate(roles, spec);

  if (rollTo != null && spec) {
    const rev = h.data?.revisions.find((r) => r.revision === rollTo);
    return (
      <ConfirmPanel
        spec={spec} req={{ namespace: target.namespace, deployment: target.deployment, revision: rollTo }} what={target.deployment}
        goLabel={`Roll ${target.deployment} back to revision ${rollTo}`}
        consequence={`${target.deployment} runs revision ${rollTo}'s pod template again${rev ? ` (${rev.images.map((i) => i.image).join(', ')})` : ''}. It becomes a new revision; pods are replaced one at a time.`}
        onBack={() => { setRollTo(null); h.reload(); }} onDone={() => { h.reload(); onChanged?.(); }}
        describe={(r: RollbackResult) => (r.skipped
          ? { line: `Revision ${r.toRevision} is already running.`, sub: 'Nothing was changed.' }
          : { line: `${target.deployment} rolled back to revision ${r.toRevision}.`, sub: `Was revision ${r.fromRevision ?? '?'}; now ${r.images.map((i) => i.image).join(', ')}.` })}
      />
    );
  }

  return (
    <div className="ka-stack">
      <div className="ka-row ka-row-between">
        <p className="sa-note">{h.data ? `${h.data.revisions.length} revision${h.data.revisions.length === 1 ? '' : 's'}, newest first.` : 'Reading history…'}</p>
        <Button variant="ghost" size="sm" onClick={h.reload}><RefreshCw size={14} aria-hidden="true" /> Refresh</Button>
      </div>
      {h.refusal && <Refused r={h.refusal} />}
      {h.data && (
        <ol className="ka-list">
          {h.data.revisions.map((r) => (
            <li key={r.revision} className="ka-item" data-current={r.current ? 'true' : 'false'}>
              <span className="ka-item-main">
                <span className="ka-item-head">
                  <History size={13} aria-hidden="true" /> <strong>Revision {r.revision}</strong>
                  {r.current && <span className="ka-flag">Running</span>}
                  <span className="dim">{ago(r.createdAt)}</span>
                </span>
                <span className="mono ka-item-sub">{r.images.map((i) => i.image).join(', ')}</span>
                <span className="dim ka-item-sub mono">{r.replicaset} · {r.readyReplicas}/{r.replicas} ready</span>
              </span>
              {!r.current && g !== 'hidden' && (
                <Button variant="ghost" size="sm" aria-disabled={g === 'enabled' ? undefined : true}
                  title={g === 'enabled' ? `Roll back to revision ${r.revision}` : 'Rolling back needs the operator role'}
                  onClick={() => { if (g === 'enabled') setRollTo(r.revision); }}>
                  <RotateCcw size={14} aria-hidden="true" /> Roll back
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ── pods ────────────────────────────────────────────────────────────────────

function PodsTab({ catalog, target, onChanged, onLogs }: { catalog: KubeCatalog; target: KubeTarget; onChanged?: () => void; onLogs: (pod: string) => void }) {
  const { roles } = useKubeRoles();
  const pods = useKubeRead<PodsResult>('pods', { namespace: target.namespace, deployment: target.deployment }, 5_000);
  const [del, setDel] = useState<string | null>(null);
  const spec = findSpec(catalog, 'delete-pod');
  const g = gate(roles, spec);
  // Where the keyboard goes back to after the inline confirm: that pod's Delete
  // button if the pod is still listed, else the tab's Refresh. Without this the
  // confirm's removal dropped focus onto the dialog container.
  const box = useRef<HTMLDivElement>(null);
  const backTo = useRef<string | null>(null);
  useEffect(() => {
    if (del || !backTo.current) return;
    const name = backTo.current;
    backTo.current = null;
    const el = box.current?.querySelector<HTMLElement>(`[data-pod-del="${CSS.escape(name)}"]`)
      ?? box.current?.querySelector<HTMLElement>('button');
    el?.focus();
  }, [del]);

  // ONE DIALOG AT A TIME (design audit CL-3, brand patterns/feedback.md). This
  // used to open a second modal - a second scrim - on top of the deployment
  // dialog; the confirm is now the same inline panel History uses.
  if (del && spec) {
    return (
      <ConfirmPanel
        spec={spec} req={{ namespace: target.namespace, pod: del }} what={del}
        onBack={() => { backTo.current = del; setDel(null); pods.reload(); }}
        onDone={() => { pods.reload(); onChanged?.(); }}
        goLabel="Delete this pod"
        consequence={`${del} is deleted and ${target.deployment} starts a replacement. With one replica, requests fail until the new pod is ready.`}
        describe={(r: DeletePodResult) => ({ line: `Deleted ${r.deleted}.`, sub: r.owner ? `${r.owner.kind} ${r.owner.name} replaces it.` : undefined })}
      />
    );
  }

  return (
    <div className="ka-stack" ref={box}>
      <div className="ka-row ka-row-between">
        <p className="sa-note">{pods.data ? `${pods.data.pods.length} pod${pods.data.pods.length === 1 ? '' : 's'} of ${target.deployment}.` : 'Reading pods…'}</p>
        <Button variant="ghost" size="sm" onClick={pods.reload}><RefreshCw size={14} aria-hidden="true" /> Refresh</Button>
      </div>
      {pods.refusal && <Refused r={pods.refusal} />}
      {pods.data && pods.data.pods.length === 0 && <p className="sa-note">No pods. A deployment scaled to 0 has none.</p>}
      {pods.data && (
        <ol className="ka-list">
          {pods.data.pods.map((p) => (
            <li key={p.name} className="ka-item">
              <span className="ka-item-main">
                <span className="ka-item-head">
                  <span className="cl-dot" data-state={podStatus(p)} aria-hidden="true" />
                  <strong className="mono">{p.name}</strong>
                </span>
                <span className="dim ka-item-sub">
                  {p.status} · {p.readyContainers}/{p.totalContainers} ready · {p.restarts} restart{p.restarts === 1 ? '' : 's'} · {ago(p.createdAt)}
                </span>
                <span className="mono dim ka-item-sub">{p.containers.map((c) => shortImage(c.image)).join(', ')}</span>
              </span>
              <span className="ka-row">
                <Button variant="ghost" size="sm" onClick={() => onLogs(p.name)}>Logs</Button>
                {g !== 'hidden' && p.deletable && (
                  <Button variant="ghost" size="sm" aria-disabled={g === 'enabled' ? undefined : true}
                    data-pod-del={p.name}
                    title={g === 'enabled' ? `Delete ${p.name}` : 'Deleting a pod needs the operator role'}
                    onClick={() => { if (g === 'enabled') setDel(p.name); }}>
                    <Trash2 size={14} aria-hidden="true" /> Delete
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ── events ──────────────────────────────────────────────────────────────────

function EventsTab({ target }: { target: KubeTarget }) {
  const ev = useKubeRead<EventsResult>('events', { namespace: target.namespace, deployment: target.deployment, limit: 50 }, 15_000);
  return (
    <div className="ka-stack">
      <div className="ka-row ka-row-between">
        <p className="sa-note">{ev.data ? `${ev.data.events.length} event${ev.data.events.length === 1 ? '' : 's'}, newest first.` : 'Reading events…'}</p>
        <Button variant="ghost" size="sm" onClick={ev.reload}>
          <RefreshCw size={14} aria-hidden="true" /> Refresh
        </Button>
      </div>
      {ev.refusal && <Refused r={ev.refusal} />}
      {ev.data && ev.data.events.length === 0 && <p className="sa-note">The cluster has nothing recent to say about {target.deployment}. Events expire after an hour.</p>}
      {ev.data && ev.data.events.length > 0 && <EventList events={ev.data.events} />}
    </div>
  );
}

export function EventList({ events }: { events: KubeEvent[] }) {
  return (
    <ol className="ka-events">
      {events.map((e, i) => (
        <li key={`${e.object}-${e.reason}-${i}`} className="ka-event" data-type={e.type === 'Warning' ? 'warn' : 'normal'}>
          <span className="ka-ev-type">{e.type === 'Warning' ? <AlertTriangle size={13} aria-hidden="true" /> : null}{e.type}</span>
          <span className="ka-ev-main">
            <span className="ka-ev-head"><strong>{e.reason}</strong> <span className="mono dim">{e.object}</span>{e.count > 1 && <span className="dim"> ×{e.count}</span>}</span>
            <span className="ka-ev-msg">{e.message}</span>
          </span>
          <time className="ka-ev-time dim" dateTime={e.lastSeen} title={e.lastSeen}>{ago(e.lastSeen)}</time>
        </li>
      ))}
    </ol>
  );
}

// ── logs ────────────────────────────────────────────────────────────────────

const KEEP_LINES = 2000;

function LogsTab({ target, initialPod }: { target: KubeTarget; initialPod?: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [pods, setPods] = useState<string[]>([]);
  const [containers, setContainers] = useState<string[]>([]);
  const [pod, setPod] = useState<string | undefined>(initialPod);
  const [container, setContainer] = useState<string | undefined>(undefined);
  const [previous, setPrevious] = useState(false);
  const [source, setSource] = useState('');
  const [refusal, setRefusal] = useState<KubeRefusal | null>(null);
  const [loading, setLoading] = useState(true);
  const [following, setFollowing] = useState(false);
  const [ended, setEnded] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const stop = useRef<(() => void) | null>(null);
  const box = useRef<HTMLPreElement>(null);
  const spec = useMemo(() => ({ title: 'Read the logs of', role: 'viewer' as const }), []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setRefusal(null);
    kubeLogs(target, 200, { pod, container, previous })
      .then((r) => {
        if (!live) return;
        setLines(r.lines); setPods(r.pods); setContainers(r.containers);
        setSource(`${r.pod} / ${r.container}${r.previous ? ' (previous)' : ''}`);
      })
      .catch((e) => { if (live) { setLines([]); setRefusal(kubeRefusalOf(e, spec, target.deployment)); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [target.namespace, target.deployment, pod, container, previous, nonce, spec]);

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
        kubeLogs(target, 1, { pod, container }).then(
          () => setEnded('The live stream dropped. The cluster tier is answering, so following again should work.'),
          (e) => setRefusal(kubeRefusalOf(e, spec, target.deployment)),
        );
      },
    }, pod, container);
  };

  const halt = () => { stop.current?.(); stop.current = null; setFollowing(false); setEnded('Stopped.'); };

  return (
    <div className="ka-stack">
      <div className="ka-row ka-row-between">
        <div className="ka-row">
          <label className="ka-inline">
            <span className="ka-label">Pod</span>
            <select className="ka-input mono ka-select" value={pod ?? ''} disabled={following} onChange={(e) => { setPod(e.target.value || undefined); setContainer(undefined); }}>
              <option value="">newest running</option>
              {pods.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          {containers.length > 1 && (
            <label className="ka-inline">
              <span className="ka-label">Container</span>
              <select className="ka-input mono ka-select" value={container ?? ''} disabled={following} onChange={(e) => setContainer(e.target.value || undefined)}>
                {containers.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          )}
          <label className="ka-check">
            <input type="checkbox" checked={previous} disabled={following} onChange={(e) => setPrevious(e.target.checked)} />
            Previous instance
          </label>
        </div>
        <div className="ka-row">
          {following ? (
            <Button variant="ghost" size="sm" onClick={halt}><CircleStop size={14} aria-hidden="true" /> Stop</Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => setNonce((n) => n + 1)}><RefreshCw size={14} aria-hidden="true" /> Refresh</Button>
              <Button size="sm" onClick={follow} disabled={previous} title={previous ? 'A previous instance has stopped writing' : undefined}>
                <CirclePlay size={14} aria-hidden="true" /> Follow
              </Button>
            </>
          )}
        </div>
      </div>
      <p className="sa-note">
        {following ? <><span className="ka-live" aria-hidden="true" /> Following </> : loading ? 'Reading logs… ' : 'Last lines from '}
        {source && <span className="mono">{source}</span>}
      </p>
      {refusal && <Refused r={refusal} />}
      {ended && <p className="sa-note" role="status">{ended}</p>}
      <pre className="ka-log mono" ref={box} tabIndex={0} aria-label={`Logs of ${target.deployment}`}>
        {lines.length ? lines.join('\n') : (loading ? '' : 'No output.')}
      </pre>
    </div>
  );
}

export function Refused({ r }: { r: KubeRefusal }) {
  return (
    <div className="sa-outcome" data-ok="false">
      <p className="sa-outcome-h">{r.title}</p>
      <p className="sa-note">{r.detail}</p>
    </div>
  );
}
