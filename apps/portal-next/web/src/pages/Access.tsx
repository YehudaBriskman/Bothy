import { useSearchParams } from 'react-router-dom';
import { usePortal } from '../lib/data';
import { PortsTab } from '../components/PortsTab';
import { RoutesTab } from '../components/RoutesTab';
import { Tabs, TabPanel } from '../components/Tabs';

// Ports and Routes were two pages answering one question: "how do I reach this
// thing?" They shared a filter bar, a table, a sort model and a stylesheet, and
// differed only in which column held the address. Two top-level destinations for
// two views of the same subject is navigation spent on an implementation detail
// - whether a service is reached through Traefik or through a published port is
// exactly what the user came here to find out, not something they should have to
// know before choosing a menu item.
//
// The tab lives in ?tab= so a specific view stays linkable, and /ports and
// /routes still resolve (App.tsx redirects them) because they are bookmarked.

type TabKey = 'routes' | 'ports';
const isTab = (v: string | null): v is TabKey => v === 'routes' || v === 'ports';

export function Access() {
  const { data } = usePortal();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: TabKey = isTab(raw) ? raw : 'routes';

  const setTab = (k: string) => {
    const next = new URLSearchParams(params);
    next.set('tab', k);
    // replace: switching a tab is not a navigation step worth a Back press.
    setParams(next, { replace: true });
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Access</h1>
          <p className="page-sub">
            {tab === 'routes'
              ? `${data.routers.length} Traefik routers · the escape hatch, nothing hidden`
              : `${data.ports.length} published · the collision map (from Docker)`}
          </p>
        </div>
      </div>

      <Tabs
        label="How services are reached"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'routes', label: 'Routes', count: data.routers.length },
          { key: 'ports', label: 'Ports', count: data.ports.length },
        ]}
      />

      <TabPanel tabKey="routes" active={tab === 'routes'}>
        <RoutesTab routers={data.routers} nodes={data.nodes} />
      </TabPanel>
      <TabPanel tabKey="ports" active={tab === 'ports'}>
        <PortsTab ports={data.ports} />
      </TabPanel>
    </div>
  );
}
