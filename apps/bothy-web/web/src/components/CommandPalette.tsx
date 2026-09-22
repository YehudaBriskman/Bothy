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
// Modal behaviour - the Tab trap, Escape from anywhere inside, the inert page
// behind, focus back where it was on close - comes from ui/Dialog's
// DialogSurface, like every other modal here. Until 2026-09-21 this drew its own
// `role="dialog" aria-modal` div with an Escape handler on the INPUT only: Tab
// walked out behind the scrim into the page, and from there Escape no longer
// closed it (design audit SH-1).
//
// A11y note: focus NEVER leaves the input. Up/Down move `active`, and the
// highlighted row is announced via aria-activedescendant pointing at its id.
// Moving real focus onto the rows would fight the input for the caret and break
// type-ahead, which is the whole point of the control.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Boxes, Layers, CornerDownLeft, ArrowUp, ArrowDown } from 'lucide-react';
import { usePortal } from '../lib/data';
import { DialogSurface } from './ui/Dialog';
import { systemsOf } from '../lib/systems';
import { Icon } from './ui/Icon';

export interface Cmd {
  id: string;
  group: 'Services' | 'Systems' | 'Go to';
  label: string;
  sub?: string;
  to: string;
  status?: string;
}

const GROUPS: Cmd['group'][] = ['Go to', 'Services', 'Systems'];

// These point at the LIVE paths, not through the redirects. Every old URL still
// resolves, so leaving them would have worked - and would have been a palette
// telling you a page lives somewhere it does not, one bounce at a time.
//
// `Access` is kept as a searchable ALIAS rather than a destination. It was the
// name of a page for months; someone who types it should land somewhere useful
// instead of getting nothing, but the label says where they are actually going.
const DESTINATIONS: Cmd[] = [
  { id: 'go-/', group: 'Go to', label: 'Overview', to: '/' },
  { id: 'go-/control', group: 'Go to', label: 'Control', sub: 'what is running, and how you reach it', to: '/control' },
  { id: 'go-/services', group: 'Go to', label: 'Services', to: '/control/services' },
  { id: 'go-/routes', group: 'Go to', label: 'Routes', sub: 'was Access', to: '/control/routes' },
  { id: 'go-/ports', group: 'Go to', label: 'Ports', sub: 'was Access', to: '/control/ports' },
  { id: 'go-/topology', group: 'Go to', label: 'Topology', to: '/control/topology' },
  { id: 'go-/files', group: 'Go to', label: 'Files', to: '/files' },
  { id: 'go-/settings', group: 'Go to', label: 'Settings', sub: 'who you are, and what that lets you do', to: '/settings' },
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
    // Escape is not handled here any more: DialogSurface closes on it from
    // anywhere inside the palette, which a handler on the input could not.
  };

  let cursor = -1; // running index across groups, so `active` maps to a flat list

  return (
    <DialogSurface
      open={open}
      onOpenChange={(o) => { if (!o) onClose(); }}
      title="Command palette"
      overlayClassName="cmdk-scrim"
      className="cmdk"
    >
        <div className="cmdk-in">
          <Icon icon={Search} size="md" />
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
                      {r.group === 'Systems' ? <Icon icon={Layers} size="md" /> : r.group === 'Services' ? <Icon icon={Boxes} size="md" /> : <Icon icon={CornerDownLeft} size="md" />}
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
          <span><Icon icon={ArrowUp} size="xs" /><Icon icon={ArrowDown} size="xs" /> navigate</span>
          <span><Icon icon={CornerDownLeft} size="xs" /> open</span>
          <span><span className="kbd">esc</span> close</span>
        </div>
    </DialogSurface>
  );
}
