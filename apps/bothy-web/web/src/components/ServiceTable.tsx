import type { PortalNode } from '../lib/discover';
import { ServiceRow } from './ServiceRow';

// The dense services table, in ONE place.
//
// The <thead> used to be hand-written verbatim in both Services.tsx and
// ProjectDetail.tsx, and rendered once per group panel - so the columns of two
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
      <table className={`tbl as-cards svc-tbl ${compact ? 'compact' : ''} ${showGroup ? '' : 'no-group'}`}>
        {/* The fixed template the comment above promises, written down at last
            (CT-16). Without a colgroup the browser sized each group's table from
            its own contents, so Status began at x=550 in one panel and x=517 in
            the next; a page of stacked service tables read as several tables
            rather than one list. The name and image columns share what is left. */}
        <colgroup>
          <col />
          <col className="svc-col-status" />
          {showGroup && <col className="svc-col-group" />}
          <col className="svc-col-kind" />
          <col className="svc-col-ports" />
          <col />
          <col className="svc-col-act" />
          <col className="svc-col-open" />
        </colgroup>
        <thead>
          <tr>
            <th>Service</th>
            <th>Status</th>
            {showGroup && <th>Group</th>}
            <th>Kind</th>
            <th>Ports</th>
            <th>Image</th>
            {/* Two unlabelled cells, and both need an accessible name: a screen
                reader announcing a column reads the header, and "blank" twice at
                the end of every row is the table refusing to say what those
                controls are. Nothing is drawn, because a visible "Actions"
                heading over a control that is transparent at rest would label an
                empty column. */}
            <th className="svc-th-act" aria-label="Actions" />
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
