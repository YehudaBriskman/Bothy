// A sortable column header: a real <button> inside the <th>, with the sort
// state as `aria-sort` on the <th> (design audit CT-1, 2026-09-21).
//
// It was a bare `<th onClick>`, which a mouse can use and a keyboard cannot:
// no tab stop, no Enter, no Space, and a screen reader heard a plain column
// header with nothing to press. The button carries the activation; the <th>
// keeps `aria-sort`, because that is the element the table semantics read it
// from - on the button it would be ignored.

export type SortDir = 1 | -1;

export function SortHeader<K extends string>({
  k, label, sort, onSort,
}: {
  k: K;
  label: string;
  sort: { key: K; dir: SortDir };
  onSort: (k: K) => void;
}) {
  const on = sort.key === k;
  return (
    <th
      aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
      className={`sortable ${on ? 'sorted' : ''}`}
    >
      <button type="button" className="sort-btn" onClick={() => onSort(k)}>
        {label}
        {/* The arrow is decoration: aria-sort already says which way. */}
        <span className="sort-caret" aria-hidden="true">{on ? (sort.dir === 1 ? '↑' : '↓') : ''}</span>
      </button>
    </th>
  );
}
