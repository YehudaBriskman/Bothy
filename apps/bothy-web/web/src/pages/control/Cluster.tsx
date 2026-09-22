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

import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { useKubeCatalog, useKubeRoles } from '../../lib/kube-catalog';
import { Tabs } from '../../components/Tabs';
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
  const { catalog, refusal } = useKubeCatalog();
  const { roles, loading } = useKubeRoles();
  const [params, setParams] = useSearchParams();
  const namespaces = catalog?.namespaces ?? [];
  const nsAsked = params.get('ns');
  const ns = nsAsked && namespaces.includes(nsAsked) ? nsAsked : namespaces[0] ?? '';
  const tabAsked = params.get('tab');
  const tab: TabKey = (TABS.find((t) => t.key === tabAsked)?.key ?? 'topology');
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    next.set(k, v);
    setParams(next, { replace: true });
  };
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
          {namespaces.length > 0 && (
            <div className="chips cl-ns" role="radiogroup" aria-label="Namespace">
              {namespaces.map((n) => (
                <button
                  key={n} type="button" role="radio" aria-checked={n === ns} className={n === ns ? 'on' : ''}
                  onClick={() => set('ns', n)}
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

      {!catalog && refusal && <Refused r={refusal} />}
      {/* useKubeCatalog keeps asking every 20s. For a refusal a role cannot fix
          - a 503 "cluster unavailable", a tier that did not answer - that retry
          IS something in progress, so it is shown; a role refusal is not. */}
      {!catalog && refusal && !refusal.needsRole && <Loader state="connect" size="sm" label="Asking the cluster tier again every 20 seconds…" />}
      {!catalog && !refusal && <Loader state="load" size="md" label="Reading what the cluster tier can do…" />}

      {catalog && ns && (
        <>
          <div className="cl-tabs scroll-shade">
            <Tabs label="Cluster views" value={tab} onChange={(k) => set('tab', k)} tabs={TABS.map((t) => ({ key: t.key, label: t.label }))} />
          </div>
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="cl-panel" key={`${ns}-${tab}`}>
            {tab === 'topology' && <TopologyTab ns={ns} />}
            {tab === 'workloads' && <WorkloadsTab ns={ns} catalog={catalog} roles={roles} />}
            {tab === 'pods' && <PodsTab ns={ns} catalog={catalog} roles={roles} />}
            {tab === 'jobs' && <JobsTab ns={ns} catalog={catalog} roles={roles} />}
            {tab === 'config' && <ConfigTab ns={ns} catalog={catalog} roles={roles} />}
            {tab === 'network' && <NetworkTab ns={ns} />}
            {tab === 'storage' && <StorageTab ns={ns} />}
            {tab === 'events' && <EventsTab ns={ns} />}
            {tab === 'metrics' && <MetricsTab ns={ns} />}
          </div>
        </>
      )}
    </div>
  );
}
