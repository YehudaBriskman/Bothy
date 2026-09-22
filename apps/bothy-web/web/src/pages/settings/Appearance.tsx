// Appearance - everything about how this BROWSER draws Bothy.
//
// Every control here applies the moment it is chosen and is kept in this browser
// only (localStorage). That is the right home for them, not a limitation: a
// density or a reading size is a fact about the screen you are sitting at. The
// theme picker, "make your own" and the reading size moved here from the old
// single Settings page with their keys unchanged - `portal-theme*` and
// `bothy-reading-v1` - so nobody's saved choice is lost by the move.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Code2, Minus, Pencil, Plus, Undo2 } from 'lucide-react';
import { useTheme } from '../../lib/theme';
import { THEME_DIR_HOST } from '../../lib/customThemes';
import { writeFile } from '../../lib/files';
import { ThemeSwatch } from '../../components/ThemeSwatch';
import { SettingBlock } from '../../components/settings/SettingBlock';
import { Choice } from '../../components/settings/bits';
import { useAppearance } from '../../lib/usePrefs';
import type { Accent, Density, DocFont, Motion } from '../../lib/prefs';
import {
  READING_DEFAULT, READING_LIMITS, READING_STEP, useReading, type Reading,
} from '../files/reading';
import { Button, buttonClass } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';

export function AppearanceSettings() {
  return (
    <>
      <DeletedTheme />
      <SettingBlock id="theme" badge="this browser"><Theme /></SettingBlock>
      <SettingBlock id="make-theme" badge="a file on the box"><MakeATheme /></SettingBlock>
      <SettingBlock id="reading" badge="this browser"><ReadingSize /></SettingBlock>
      <PrefBlocks />
    </>
  );
}

/**
 * "Deleted X - Undo" (ST-15, decision 7).
 *
 * The theme editor deletes the file and navigates here carrying the bytes it
 * was holding; this puts them back on request. The window is ten seconds - long
 * enough to notice the mistake, short enough that the offer is gone by the time
 * you have moved on - and the state is cleared from history either way, so a
 * back-and-forward through this page does not re-offer an undo for a delete
 * that happened five minutes ago.
 *
 * It replaced a native confirm(). A confirmation is what you owe someone when
 * you cannot give the thing back.
 */
const UNDO_MS = 10_000;

function DeletedTheme() {
  const loc = useLocation();
  const nav = useNavigate();
  const { rescan } = useTheme();
  const deleted = (loc.state as { deleted?: { id: string; name: string; css: string } } | null)?.deleted;
  const [gone, setGone] = useState(false);
  const [state, setState] = useState<'offer' | 'working' | 'done' | 'failed'>('offer');

  // The router state is consumed on arrival: it has done its job, and leaving
  // it in history means every return to this entry offers the undo again.
  useEffect(() => {
    if (deleted) nav(loc.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!deleted || state !== 'offer') return;
    const t = setTimeout(() => setGone(true), UNDO_MS);
    return () => clearTimeout(t);
  }, [deleted, state]);

  const undo = useCallback(async () => {
    if (!deleted) return;
    setState('working');
    const out = await writeFile('stacks', `${THEME_DIR_HOST}${deleted.id}.css`, deleted.css, `restore theme ${deleted.id}`);
    if (out.kind === 'saved') { rescan(); setState('done'); } else setState('failed');
  }, [deleted, rescan]);

  if (!deleted || (gone && state === 'offer')) return null;
  return (
    <p className="set-undo" data-tone={state === 'failed' ? 'bad' : 'info'} role="status">
      <span>
        {state === 'done' ? `Restored ${deleted.name}.`
          : state === 'failed' ? `${deleted.name} could not be written back. It is still in the undo snapshot on the box.`
            : `Deleted ${deleted.name}.`}
      </span>
      {state === 'offer' && (
        <Button variant="ghost" size="sm" onClick={() => void undo()}>
          <Icon icon={Undo2} size="sm" /> Undo
        </Button>
      )}
      {state === 'working' && <span className="dim">Putting it back…</span>}
    </p>
  );
}

function Theme() {
  const { selection, theme, themes, setSelection } = useTheme();
  const custom = themes.filter((t) => t.user).length;
  // ST-16: a roving tabindex over the radio group. Eight themes were eight tab
  // stops plus their Edit links - seventeen presses to get past a control that
  // is one choice. The keys are the ones a radiogroup answers to.
  const box = useRef<HTMLDivElement>(null);
  const ids: string[] = ['system', ...themes.map((t) => t.id)];
  const focusAt = (id: string) => {
    setSelection(id === 'system' ? 'system' : id);
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>(`[data-theme-id="${CSS.escape(id)}"]`)?.focus());
  };
  const onKey = (e: React.KeyboardEvent) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1
        : e.key === 'Home' ? 'home' : e.key === 'End' ? 'end' : 0;
    if (!d) return;
    e.preventDefault();
    const at = Math.max(0, ids.indexOf(selection));
    const j = d === 'home' ? 0 : d === 'end' ? ids.length - 1 : (at + d + ids.length) % ids.length;
    focusAt(ids[j]);
  };
  return (
    <>
      <p className="set-lede">
        Applies as you pick. The topbar button still toggles dark, light and system in one tap; the full list is here.
        {custom > 0 && (
          <> A theme tagged <span className="theme-tag">yours</span> came from a file on the box rather than from the app.</>
        )}
      </p>
      <div className="theme-grid" role="radiogroup" aria-label="Theme" ref={box} onKeyDown={onKey}>
        <button
          type="button"
          role="radio"
          data-theme-id="system"
          tabIndex={selection === 'system' ? 0 : -1}
          aria-checked={selection === 'system'}
          className={`theme-card ${selection === 'system' ? 'is-on' : ''}`}
          onClick={() => setSelection('system')}
        >
          <span className="theme-name">System</span>
          <span className="theme-note">Follow the desktop. Currently {theme.name.replace(/^Bothy /, '').toLowerCase()}.</span>
        </button>
        {themes.map((t) => (
          // ST-16: the Edit link is a SIBLING of the radio, not a link nested
          // inside a button - which is invalid, and which browsers resolve by
          // guessing. `.theme-slot` is the positioned box both sit in.
          <div className="theme-slot" key={t.id}>
            <button
              type="button"
              role="radio"
              data-theme-id={t.id}
              tabIndex={selection === t.id ? 0 : -1}
              aria-checked={selection === t.id}
              className={`theme-card ${selection === t.id ? 'is-on' : ''}`}
              onClick={() => setSelection(t.id)}
            >
              <span className="theme-name">
                {t.name}
                {t.user && <span className="theme-tag">yours</span>}
              </span>
              <span className="theme-note">{t.note}</span>
              <ThemeSwatch id={t.id} />
            </button>
            {t.user && (
              <Link
                to={`/settings/theme/${t.id}`}
                className="theme-edit"
                aria-label={`Edit ${t.name}`}
              >
                <Icon icon={Pencil} size="xs" /> Edit
              </Link>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function MakeATheme() {
  const { themes } = useTheme();
  const custom = themes.filter((t) => t.user).length;
  // Both routes produce the same thing - one .css file in one directory - which
  // is the point the two cards make side by side.
  return (
    <>
      <div className="make-grid">
        <Link to="/settings/theme/new" className="make">
          <p className="make-h"><Icon icon={Plus} size="md" /> In the theme editor</p>
          <p className="make-p">
            Starts from the theme you are using now and applies every change to the whole page as you type. The palette
            rules run live and warn; they never refuse. Saving writes the file, which needs the{' '}
            <span className="mono">editor</span> role.
          </p>
        </Link>
        <div className="make">
          <p className="make-h"><Icon icon={Code2} size="md" /> Or write the file</p>
          <p className="make-p">
            Drop a <code className="mono">.css</code> file into <code className="mono">{THEME_DIR_HOST}</code> on the box
            and reload. <code className="mono">README.md</code> in that directory documents the format.
          </p>
        </div>
      </div>
      <p className="set-note make-count">
        {custom === 0
          ? 'Nothing is in that directory yet, so every theme above came from the app.'
          : custom === 1 ? 'One theme above came from there.' : `${custom} of the themes above came from there.`}
      </p>
    </>
  );
}

function ReadingSize() {
  const [reading, setReading] = useReading();
  const rows: { key: keyof Reading; label: string; hint: string }[] = [
    { key: 'doc', label: 'Document text', hint: 'The rendered page in Files - prose, tables and code.' },
    { key: 'ui', label: 'Panel text', hint: 'The document index on the left and the outline on the right.' },
  ];
  return (
    <div className="set-reading">
      {rows.map(({ key, label, hint }) => {
        const v = reading[key];
        const { min, max } = READING_LIMITS[key];
        const step = READING_STEP[key];
        return (
          <div className="set-read-row" key={key}>
            <div className="set-read-lbl">
              <span className="set-read-name">{label}</span>
              <span className="set-read-hint">{hint}</span>
            </div>
            <div className="set-read-ctl" role="group" aria-label={label}>
              <button type="button" className="icon-btn set-read-btn" onClick={() => setReading({ [key]: v - step })}
                disabled={v <= min} aria-label={`Smaller ${label.toLowerCase()}`}>
                <Icon icon={Minus} size="sm" />
              </button>
              <span className="set-read-v tnum" aria-live="polite">{v}px</span>
              <button type="button" className="icon-btn set-read-btn" onClick={() => setReading({ [key]: v + step })}
                disabled={v >= max} aria-label={`Larger ${label.toLowerCase()}`}>
                <Icon icon={Plus} size="sm" />
              </button>
              <Button variant="ghost" size="sm" onClick={() => setReading({ [key]: READING_DEFAULT[key] })}
                disabled={v === READING_DEFAULT[key]}>
                Reset
              </Button>
            </div>
            <p className="set-read-sample" style={{ fontSize: `${v / 16}rem` }}>
              {key === 'doc' ? 'The quick brown fox jumps over the lazy dog.' : 'Tailnet troubleshooting'}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function PrefBlocks() {
  const [a, setA] = useAppearance();
  const { theme } = useTheme();
  const builtIn = theme.id === 'bothy-dark' || theme.id === 'bothy-light';
  return (
    <>
      <SettingBlock id="doc-font" badge="this browser">
        <Choice<DocFont>
          label="Rendered documents in Files use"
          name="doc-font"
          value={a.docFont}
          onChange={(docFont) => setA({ ...a, docFont })}
          options={[
            { value: 'sans', label: 'Sans', hint: 'The interface font. The default.' },
            { value: 'serif', label: 'Serif', hint: 'A system serif for long prose. Code stays monospace.' },
          ]}
        />
        <p className={`set-font-sample ${a.docFont === 'serif' ? 'is-serif' : ''}`}>
          A bothy is a hut left unlocked for whoever needs shelter.
        </p>
      </SettingBlock>

      <SettingBlock id="density" badge="this browser">
        <Choice<Density>
          label="Table rows"
          name="density"
          value={a.density}
          onChange={(density) => setA({ ...a, density })}
          options={[
            { value: 'comfortable', label: 'Comfortable', hint: 'The default padding.' },
            { value: 'compact', label: 'Compact', hint: 'Less padding, same type size - more rows on screen.' },
          ]}
        />
      </SettingBlock>

      <SettingBlock id="motion" badge="this browser">
        <Choice<Motion>
          label="Transitions and animations"
          name="motion"
          value={a.motion}
          onChange={(motion) => setA({ ...a, motion })}
          options={[
            { value: 'system', label: 'Follow the system', hint: 'Reduced when the operating system asks for less motion.' },
            { value: 'reduce', label: 'Reduce here', hint: 'Off in this browser, whatever the system says.' },
          ]}
        />
      </SettingBlock>

      <SettingBlock id="accent" badge="this browser">
        <Choice<Accent>
          label="Accent colour"
          name="accent"
          value={a.accent}
          onChange={(accent) => setA({ ...a, accent })}
          options={[
            { value: 'theme', label: 'Theme default', hint: 'Blue on Bothy Dark and Light; a named theme uses its own.' },
            { value: 'violet', label: 'Violet', hint: 'Links, focus rings, the current-page marker.' },
            { value: 'cyan', label: 'Cyan', hint: 'The same places, in cyan.' },
          ]}
        />
        <p className="set-note">
          {builtIn
            ? 'The accent is chrome: it marks where you are and what you can press, and it never means a state. Every option keeps its distance from the status colours.'
            : `You are using ${theme.name}, which declares its own accent, so this choice waits until you pick Bothy Dark or Bothy Light.`}
        </p>
        <div className="set-accent-demo" aria-hidden="true">
          <span className={buttonClass({ variant: 'primary', size: 'sm' })}>Primary button</span>
          <span className="link">A link</span>
          <span className="set-accent-ring">Focus ring</span>
        </div>
      </SettingBlock>
    </>
  );
}
