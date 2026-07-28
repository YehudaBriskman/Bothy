import { usePortal } from '../lib/data';
import { RoutesTab } from '../components/RoutesTab';

export function RoutesPage() {
  const { data } = usePortal();
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Routes</h1>
          <p className="page-sub">{data.routers.length} Traefik routers · the escape hatch, nothing hidden</p>
        </div>
      </div>
      <RoutesTab routers={data.routers} nodes={data.nodes} />
    </div>
  );
}
