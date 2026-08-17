// Command palette - ⌘K / Ctrl-K, or the topbar search button.
//
// Replaces a topbar <input> that called navigate() on every keystroke: typing
// "postgres" pushed eight history entries and re-rendered the Services page
// eight times, and it could only ever find services. This searches services,
// systems and actions in one list and navigates once, on Enter.
//
// Hand-written on purpose. cmdk is ~14 KB gzipped to rank a list that is 27
// services + 13 systems + 5 destinations long; a substring match over 45 items
// is not a problem worth a dependency.
//
// A11y note: focus NEVER leaves the input. Up/Down move `active`, and the
// highlighted row is announced via aria-activedescendant pointing at its id.
// Moving real focus onto the rows would fight the input for the caret and break
// type-ahead, which is the whole point of the control.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Boxes, Layers, CornerDownLeft, ArrowUp, ArrowDown } from 'lucide-react';
import { usePortal } from '../lib/data';
import { systemsOf } from '../lib/systems';

export interface Cmd {
  id: string;
  group: 'Services' | 'Systems' | 'Go to';
  label: string;
  sub?: string;
  to: string;
  status?: string;
}

const GROUPS: Cmd['group'][] = ['Go to', 'Services', 'Systems'];

const DESTINATIONS: Cmd[] = [
  { id: 'go-/', group: 'Go to', label: 'Overview', to: '/' },
  { id: 'go-/services', group: 'Go to', label: 'Services', to: '/services' },
  // Both spellings stay reachable by name even though they are one page now -
  // someone who thinks "ports" should not have to know it was merged.
  { id: 'go-/access', group: 'Go to', label: 'Access', sub: 'routes + ports', to: '/access?tab=routes' },
  { id: 'go-/ports', group: 'Go to', label: 'Ports', sub: 'in Access', to: '/access?tab=ports' },
  { id: 'go-/topology', group: 'Go to', label: 'Topology', to: '/topology' },
];

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data } = usePortal();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo<Cmd[]>(() => {
    const services: Cmd[] = data.nodes
      .filter((n) => !n.hidden)
      .map((n) => ({
        id: `svc-${n.id}`,
        group: 'Services' as const,
        label: n.name,
        sub: n.host || n.groupTitle,
        to: `/services/${encodeURIComponent(n.id)}`,
        status: n.status,
      }));
    const systems: Cmd[] = systemsOf(data.nodes).map((s) => ({
      id: `sys-${s.key}`,
      group: 'Systems' as const,
      label: s.title,
      sub: `${s.up}/${s.total} up`,
      to: `/systems/${encodeURIComponent(s.key)}`,
    }));
    return [...DESTINATIONS, ...services, ...systems];
  }, [data.nodes]);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hit = needle
      ? items.filter(
          (i) => i.label.toLowerCase().includes(needle) || (i.sub ?? '').toLowerCase().includes(needle),
        )
      : items;
    // Stable group order regardless of the order they were concatenated in.
    return [...hit].sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
  }, [items, q]);

  // Reset per opening, not per keystroke - reopening should not remember a
  // half-typed query from three pages ago.
  useEffect(() => {
    if (open) { setQ(''); setActive(0); inputRef.current?.focus(); }
  }, [open]);

  useEffect(() => { setActive(0); }, [q]);

  // Keep the highlighted row in view when arrowing past the fold. `nearest`
  // rather than `center` so a short list does not jump around under the cursor.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  if (!open) return null;

  const go = (c: Cmd | undefined) => {
    if (!c) return;
    onClose();
    nav(c.to);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(results.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); go(results[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  let cursor = -1; // running index across groups, so `active` maps to a flat list

  return (
    <div
      className="cmdk-scrim"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="cmdk-in">
          <Search size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search services, systems, pages…"
            aria-label="Search services, systems and pages"
            aria-controls="cmdk-list"
            aria-activedescendant={results[active] ? `cmdk-opt-${results[active].id}` : undefined}
            role="combobox"
            aria-expanded="true"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="cmdk-list scroll-shade" id="cmdk-list" role="listbox" ref={listRef}>
          {results.length === 0 && <div className="cmdk-empty">Nothing matches “{q}”.</div>}
          {GROUPS.map((g) => {
            const rows = results.filter((r) => r.group === g);
            if (!rows.length) return null;
            return (
              <div key={g}>
                <div className="cmdk-group">{g}</div>
                {rows.map((r) => {
                  cursor += 1;
                  const i = cursor;
                  return (
                    <div
                      key={r.id}
                      id={`cmdk-opt-${r.id}`}
                      role="option"
                      aria-selected={i === active}
                      className="cmdk-item"
                      onMouseMove={() => setActive(i)}
                      onClick={() => go(r)}
                    >
                      {r.group === 'Systems' ? <Layers size={15} /> : r.group === 'Services' ? <Boxes size={15} /> : <CornerDownLeft size={15} />}
                      {r.status && <span className="dot" data-state={r.status} />}
                      <span>{r.label}</span>
                      {r.sub && <span className="cmdk-sub">{r.sub}</span>}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div className="cmdk-foot">
          <span><ArrowUp size={11} /><ArrowDown size={11} /> navigate</span>
          <span><CornerDownLeft size={11} /> open</span>
          <span><span className="kbd">esc</span> close</span>
        </div>
      </div>
    </div>
  );
}
