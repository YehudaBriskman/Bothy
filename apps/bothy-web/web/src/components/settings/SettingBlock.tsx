// One setting block - GitLab's unit: a title, a one-line description, an
// Expand/Collapse button, and a body that saves on its own.
//
// Title and description come from lib/settings-index.ts by id, never from props,
// so the text the search finds is the text on the page.
//
// OPEN STATE. Expanded is the default: most of Bothy's blocks are live data
// rather than forms, and a page of closed boxes hides the one thing it exists
// to show. What a person collapses is remembered per browser under
// `bothy-settings-nav-v1` (block id -> false), the same "remember the change,
// not the default" shape as bothy-collapsed-groups-v1.
//
// `?block=<id>` - from the search, or a link somebody pasted - forces the block
// open, scrolls it into view and marks it briefly. It is a query and not a
// fragment because under HashRouter the fragment is the route.
//
// SAVING. A block with a draft passes `dirty`, `onSave` and `onDiscard`, and the
// footer appears only while there is something to save. A block whose control
// applies immediately (a theme, a density) passes none of them and says so in
// its description - two save models on one page is only confusing when they
// look the same.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { blockById } from '../../lib/settings-index';

const OPEN_KEY = 'bothy-settings-nav-v1';

function readOpen(): Record<string, boolean> {
  try {
    const j: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}');
    if (!j || typeof j !== 'object' || Array.isArray(j)) return {};
    return Object.fromEntries(Object.entries(j).filter(([, v]) => v === false)) as Record<string, boolean>;
  } catch {
    return {};
  }
}

function writeOpen(id: string, open: boolean) {
  const cur = readOpen();
  if (open) delete cur[id];
  else cur[id] = false;
  try { localStorage.setItem(OPEN_KEY, JSON.stringify(cur)); } catch { /* not fatal */ }
}

export interface SettingBlockProps {
  id: string;
  children: ReactNode;
  /** A short word beside the title: `read-only`, `this browser`, `operator`. */
  badge?: ReactNode;
  dirty?: boolean;
  saving?: boolean;
  onSave?: () => void;
  onDiscard?: () => void;
  /** Said beside the Save button - what saving does and where it lands. */
  saveNote?: ReactNode;
}

export function SettingBlock({ id, children, badge, dirty, saving, onSave, onDiscard, saveNote }: SettingBlockProps) {
  const def = blockById(id);
  const [params] = useSearchParams();
  const targeted = params.get('block') === id;
  const [open, setOpen] = useState(() => targeted || readOpen()[id] !== false);
  const [flash, setFlash] = useState(false);
  const ref = useRef<HTMLElement | null>(null);
  const uid = useId();

  useEffect(() => {
    if (!targeted) return;
    setOpen(true);
    setFlash(true);
    // After the body has rendered, so the scroll lands on the block's final
    // position rather than where it was while collapsed.
    const t = setTimeout(() => ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60);
    const f = setTimeout(() => setFlash(false), 1800);
    return () => { clearTimeout(t); clearTimeout(f); };
  }, [targeted]);

  const toggle = () => {
    setOpen((o) => {
      writeOpen(id, !o);
      return !o;
    });
  };

  const title = def?.title ?? id;
  return (
    <section
      ref={ref}
      id={`block-${id}`}
      className={`set-block ${open ? 'is-open' : ''} ${flash ? 'is-target' : ''}`}
      aria-labelledby={`${uid}-t`}
    >
      <header className="set-block-h">
        <div className="set-block-ht">
          <h2 id={`${uid}-t`} className="set-block-title">
            {title}
            {badge && <span className="set-badge">{badge}</span>}
          </h2>
          {def?.description && <p className="set-block-desc">{def.description}</p>}
        </div>
        <button
          type="button"
          className="btn ghost sm set-block-toggle"
          aria-expanded={open}
          aria-controls={`${uid}-b`}
          onClick={toggle}
        >
          <span>{open ? 'Collapse' : 'Expand'}</span>
          <ChevronDown size={14} aria-hidden="true" className="set-block-chev" />
        </button>
      </header>
      {open && (
        <div className="set-block-b" id={`${uid}-b`}>
          {children}
          {onSave && dirty && (
            <div className="set-save" role="region" aria-label={`Unsaved changes to ${title}`}>
              {saveNote && <p className="set-save-note">{saveNote}</p>}
              <div className="set-save-btns">
                {onDiscard && (
                  <button type="button" className="btn ghost sm" onClick={onDiscard} disabled={saving}>Discard</button>
                )}
                <button type="button" className="btn primary sm" onClick={onSave} disabled={saving}>
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
