import { usePortal } from '../lib/data';
import { PortsTab } from '../components/PortsTab';

export function PortsPage() {
  const { data } = usePortal();
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Ports</h1>
          <p className="page-sub">{data.ports.length} published · the collision map (from Docker)</p>
        </div>
      </div>
      <PortsTab ports={data.ports} />
    </div>
  );
}
