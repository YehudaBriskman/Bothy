// /control/cluster - the two Thales namespaces, as an OpenShift-console-shaped page.
//
// Everything on it comes from bothy-ops' kube tier (apps/bothy-ops/kube.py) and
// its catalog (GET /-/api/kube/catalog), except the Metrics tab, which reads the
// kubelet's cAdvisor series through the existing /-/api/prom/query_range.
//
// WHY A PAGE AS WELL AS THE ROW DIALOG. The dialog answers "act on this
// deployment". This answers "what is in the namespace": the Services, Routes,
// Jobs, ConfigMap and events that belong to no one row. The dialog is reused
// here for anything that IS about one deployment, so there is one way to roll
// back, not two.
//
// State that is worth a link lives in the URL (?ns=, ?tab=), so a bookmark or a
// pasted link opens on the same namespace and tab.
//
// ROLES ARE FOR DRAWING. A viewer sees every read and the change buttons drawn
// disabled with the reason; a session with neither role sees the reads fail
// with the edge's own 401/403 in words. lib/cluster.ts gate() is the rule, and
// the service and the edge enforce it regardless.

import { useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { useKubeCatalog, useKubeRoles } from '../../lib/kube-catalog';
import { Tabs, TabGroup, TabPanel } from '../../components/Tabs';
import { Refused } from '../../components/KubeActions';
import {
  ConfigTab, EventsTab, JobsTab, MetricsTab, NetworkTab, PodsTab, StorageTab, TopologyTab, WorkloadsTab,
} from './ClusterTabs';
import './cluster.css';
import { buttonClass } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { Loader } from '../../components/ui/Loader';

const TABS = [
  { key: 'topology', label: 'Topology' },
  { key: 'workloads', label: 'Workloads' },
  { key: 'pods', label: 'Pods' },
  { key: 'jobs', label: 'Jobs' },
  { key: 'config', label: 'Config' },
  { key: 'network', label: 'Network' },
  { key: 'storage', label: 'Storage' },
  { key: 'events', label: 'Events' },
  { key: 'metrics', label: 'Metrics' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

export function Cluster() {
  const nsBox = useRef<HTMLDivElement>(null);
  const { catalog, refusal } = useKubeCatalog();
  const { roles, loading } = useKubeRoles();
  const [params, setParams] = useSearchParams();
  const namespaces = catalog?.namespaces ?? [];
  const nsAsked = params.get('ns');
  const ns = nsAsked && namespaces.includes(nsAsked) ? nsAsked : namespaces[0] ?? '';
  const tabAsked = params.get('tab');
  const tab: TabKey = (TABS.find((t) => t.key === tabAsked)?.key ?? 'topology');
  // CL-25: a `?ns=` or `?tab=` that does not resolve fell back SILENTLY, so the
  // address bar went on naming a namespace the page was not showing - and that
  // URL, copied out of the bar into a chat, took the next person somewhere else
  // again. The resolved values are written back (replace, so the dead URL stays
  // out of the history), and a namespace that was asked for and does not exist
  // is said out loud rather than swapped underneath.
  const nsMissing = !!nsAsked && namespaces.length > 0 && !namespaces.includes(nsAsked);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    next.set(k, v);
    setParams(next, { replace: true });
  };
  useEffect(() => {
    if (!ns) return;
    if (nsAsked === ns && tabAsked === tab) return;
    const next = new URLSearchParams(params);
    next.set('ns', ns);
    next.set('tab', tab);
    setParams(next, { replace: true });
    // `params` is read but not depended on: this write would otherwise re-fire
    // on its own result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ns, tab, nsAsked, tabAsked, setParams]);
  const headlamp = useMemo(() => `http://${location.hostname}:8110`, []);

  return (
    <div className="page cl-page">
      <div className="page-head cl-head">
        <div>
          <h1>Cluster</h1>
          <p className="page-sub">
            thales-scc · {ns || 'no namespace'} · read by bothy-ops{!loading && !roles.includes('operator') ? ' · read-only for you' : ''}
          </p>
        </div>
        <div className="cl-head-aside">
          {/* CL-19: a roving tabindex, like Tabs. Every namespace used to be its
              own tab stop, so a keyboard user crossed the whole group to get
              past it - and a radiogroup is ONE control, which is what the arrow
              keys are for. */}
          {namespaces.length > 0 && (
            <div className="chips cl-ns" role="radiogroup" aria-label="Namespace" ref={nsBox}>
              {namespaces.map((n, i) => (
                <button
                  key={n} type="button" role="radio" aria-checked={n === ns} className={n === ns ? 'on' : ''}
                  data-ns={n}
                  tabIndex={n === ns || (!namespaces.includes(ns) && i === 0) ? 0 : -1}
                  onClick={() => set('ns', n)}
                  onKeyDown={(e) => {
                    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
                      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1
                        : e.key === 'Home' ? 'home' : e.key === 'End' ? 'end' : 0;
                    if (!d) return;
                    e.preventDefault();
                    const at = namespaces.indexOf(ns);
                    const j = d === 'home' ? 0 : d === 'end' ? namespaces.length - 1
                      : (at + d + namespaces.length) % namespaces.length;
                    set('ns', namespaces[j]);
                    nsBox.current?.querySelector<HTMLElement>(`[data-ns="${namespaces[j]}"]`)?.focus();
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
          )}
          <a className={buttonClass({ variant: 'ghost', size: 'sm' }, 'cl-headlamp')} href={headlamp} target="_blank" rel="noreferrer">
            Browse in Headlamp <Icon icon={ExternalLink} size="sm" />
          </a>
        </div>
      </div>

      {nsMissing && (
        <p className="sa-note cl-ns-note" role="status">
          There is no namespace <span className="mono">{nsAsked}</span> in this cluster tier.
          Showing <span className="mono">{ns}</span>.
        </p>
      )}

      {!catalog && refusal && <Refused r={refusal} />}
      {/* useKubeCatalog keeps asking every 20s. For a refusal a role cannot fix
          - a 503 "cluster unavailable", a tier that did not answer - that retry
          IS something in progress, so it is shown; a role refusal is not. */}
      {!catalog && refusal && !refusal.needsRole && <Loader state="connect" size="sm" label="Asking the cluster tier again every 20 seconds…" />}
      {!catalog && !refusal && <Loader state="load" size="md" label="Reading what the cluster tier can do…" />}

      {catalog && ns && (
        <>
          <TabGroup>
          <div className="cl-tabs">
            <Tabs label="Cluster views" value={tab} onChange={(k) => set('tab', k)} tabs={TABS.map((t) => ({ key: t.key, label: t.label }))} />
          </div>
          {/* CL-18: through TabPanel, so this panel and the tablist above it
              agree on an id prefix nothing else in the document shares - the
              dialog this page opens has tabs called "pods" and "events" too. */}
          <TabPanel tabKey={tab} active className="cl-panel" key={`${ns}-${tab}`}>
            {tab === 'topology' && <TopologyTab ns={ns} />}
            {tab === 'workloads' && <WorkloadsTab ns={ns} catalog={catalog} roles={roles} />}
            {tab === 'pods' && <PodsTab ns={ns} catalog={catalog} roles={roles} />}
            {tab === 'jobs' && <JobsTab ns={ns} catalog={catalog} roles={roles} />}
            {tab === 'config' && <ConfigTab ns={ns} catalog={catalog} roles={roles} />}
            {tab === 'network' && <NetworkTab ns={ns} />}
            {tab === 'storage' && <StorageTab ns={ns} />}
            {tab === 'events' && <EventsTab ns={ns} />}
            {tab === 'metrics' && <MetricsTab ns={ns} />}
          </TabPanel>
          </TabGroup>
        </>
      )}
    </div>
  );
}
