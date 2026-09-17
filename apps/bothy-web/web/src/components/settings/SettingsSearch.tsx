// "Search settings" - a combobox over lib/settings-index.ts.
//
// The input keeps focus while arrow keys move through the results
// (aria-activedescendant), which is the command palette's model and the one the
// design system writes down for "a search that offers a list". Enter opens the
// highlighted hit: the section, or the section with `?block=` so the block is
// expanded and scrolled to. The query is NOT a route, so typing does not add a
// history entry per character (navigation.md, dead ends).

import { useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { hitPath, searchSettings } from '../../lib/settings-index';
import { SectionIcon } from './icons';

export function SettingsSearch() {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const id = useId();
  const input = useRef<HTMLInputElement | null>(null);
  const hits = useMemo(() => searchSettings(q, 10), [q]);

  const go = (i: number) => {
    const h = hits[i];
    if (!h) return;
    nav(hitPath(h));
    setQ('');
    setOpen(false);
    input.current?.blur();
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setAt((a) => Math.min(a + 1, hits.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(at); }
    else if (e.key === 'Escape') { if (q) { e.preventDefault(); setQ(''); } else input.current?.blur(); }
  };

  const showList = open && q.trim().length > 0;

  return (
    <div className="set-search">
      <label htmlFor={`${id}-in`} className="sr-only">Search settings</label>
      <div className="set-search-box">
        <Search size={14} aria-hidden="true" className="set-search-ico" />
        <input
          id={`${id}-in`}
          ref={input}
          type="search"
          className="set-search-in"
          placeholder="Search settings"
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={showList}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={showList && hits[at] ? `${id}-opt-${at}` : undefined}
          value={q}
          onChange={(e) => { setQ(e.target.value); setAt(0); setOpen(true); }}
          onFocus={() => setOpen(true)}
          // A click on a result lands before the blur hides the list.
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKey}
        />
      </div>
      {showList && (
        <ul className="set-search-list" id={`${id}-list`} role="listbox" aria-label="Matching settings">
          {hits.length === 0 && <li className="set-search-none" role="presentation">No setting matches “{q.trim()}”.</li>}
          {hits.map((h, i) => (
            <li
              key={`${h.section.id}/${h.block?.id ?? ''}`}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === at}
              className={`set-search-opt ${i === at ? 'on' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); go(i); }}
              onMouseEnter={() => setAt(i)}
            >
              <SectionIcon name={h.section.icon} size={14} />
              <span className="set-search-txt">
                <span className="set-search-t">{h.block ? h.block.title : h.section.title}</span>
                <span className="set-search-s">
                  {h.block ? `${h.section.title} · ${h.block.description}` : h.section.lede}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
