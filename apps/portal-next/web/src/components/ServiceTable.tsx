import type { PortalNode } from '../lib/discover';
import { ServiceRow } from './ServiceRow';

// The dense services table, in ONE place.
//
// The 7-column <thead> used to be hand-written verbatim in both Services.tsx and
// ProjectDetail.tsx, and rendered once per group panel — so the columns of two
// sections on the same page could not be relied on to line up, and adding a
// column meant editing two files. A fixed column template keeps every instance
// aligned regardless of its contents.
//
// `showGroup` drops the Group column on a system page, where every row would
// otherwise repeat the same value the page is already titled with.
export function ServiceTable({
  nodes,
  compact = false,
  showGroup = true,
  label = 'Services',
}: {
  nodes: PortalNode[];
  compact?: boolean;
  showGroup?: boolean;
  label?: string;
}) {
  return (
    // tabIndex/role so keyboard users can actually scroll the overflow container
    <div className="tbl-wrap scroll-shade" tabIndex={0} role="region" aria-label={label}>
      <table className={`tbl svc-tbl ${compact ? 'compact' : ''} ${showGroup ? '' : 'no-group'}`}>
        <thead>
          <tr>
            <th>Service</th>
            <th>Status</th>
            {showGroup && <th>Group</th>}
            <th>Kind</th>
            <th>Ports</th>
            <th>Image</th>
            <th aria-label="Open" />
          </tr>
        </thead>
        <tbody>
          {nodes.map((n) => (
            <ServiceRow key={n.id} node={n} showGroup={showGroup} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
