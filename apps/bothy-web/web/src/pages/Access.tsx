import { usePortal } from '../lib/data';
import { PortsTab } from '../components/PortsTab';
import { RoutesTab } from '../components/RoutesTab';

// Ports and Routes were two pages, then one page with two tabs, and are now two
// entries in the Control sidebar. The merge was right about the question - both
// answer "how do I reach this thing?" - and wrong about the shape: a tab HIDES.
// You could not see that Ports existed until you had already landed on Access,
// so the third navigation level was invisible from the second, which is the
// defect docs/plans/control-and-settings.md §2 names. A sidebar entry is visible
// from the section landing; a tab is not.
//
// So the pair keeps its shared components (PortsTab, RoutesTab, Tables.css) and
// loses the tab strip. `?tab=` is gone with it - the view is a path again, which
// is what it was in the first place, and every old URL including the query form
// still resolves (pages/control/redirects.ts).
//
// The file is still Access.tsx because that is what these two are, together, and
// a rename here is a diff across every import for no reader's benefit.

export function Ports() {
  const { data } = usePortal();
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Ports</h1>
          <p className="page-sub">
            {data.ports.length} published · the collision map (from Docker)
          </p>
        </div>
      </div>
      <PortsTab ports={data.ports} />
    </div>
  );
}

export function Routes() {
  const { data } = usePortal();
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Routes</h1>
          <p className="page-sub">
            {data.routers.length} Traefik routers · the escape hatch, nothing hidden
          </p>
        </div>
      </div>
      <RoutesTab routers={data.routers} nodes={data.nodes} />
    </div>
  );
}
