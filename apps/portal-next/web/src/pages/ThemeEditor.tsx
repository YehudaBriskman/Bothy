// Make a theme without leaving the box.
//
// WHAT THIS IS, MECHANICALLY: a form over a token map, a live preview, and a
// writer that produces a .css file in apps/portal-next/data/themes. Nothing
// here is a new storage format or a new write path - it composes two things
// that already exist. The file it writes is the same file you would have
// written by hand, and data/themes/README.md documents that format for people
// who would rather use an editor they already have.
//
// THE PREVIEW IS THE POINT. Picking colours from hex values in a form is
// guessing; the whole reason this page exists rather than a link to the file is
// that you can see the result while you choose. So the draft is applied to the
// document as you type - not to a swatch in the corner - and reverted when you
// leave. What you are looking at IS the theme.
//
// THE CONTRACT WARNS, IT DOES NOT REFUSE. Bothy's own themes are held to the
// accent-vs-status separation and the contrast floors by a check that fails the
// build. A theme you made on your own box is yours: the same rules run, live,
// and say exactly what is wrong and why - and then you save it anyway if you
// want to. The rules exist to stop you making a mistake by accident, not to
// stop you making a decision.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Check, Code2, Save, Trash2 } from 'lucide-react';
import { evaluateTheme, type Finding } from '../lib/contract';
import {
  activeValues, fromCss, GROUPS, isSimpleColour, requiredNames, slugify, toCss,
  type Draft,
} from '../lib/themeDraft';
import { THEME_DIR_HOST } from '../lib/customThemes';
import { deleteFile, isAuthError, readFile, writeFile } from '../lib/files';
import { hasRole } from '../lib/me';
import { useMe } from '../components/UserMenu';
import { useTheme } from '../lib/theme';
import './ThemeEditor.css';

const ROOT = 'stacks';
const dirOf = (id: string) => `${THEME_DIR_HOST}${id}.css`;

export function ThemeEditor() {
  const { id: routeId } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { me } = useMe();
  const { setSelection } = useTheme();
  const editing = routeId && routeId !== 'new' ? routeId : null;

  const names = useMemo(() => requiredNames(), []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseMtime, setBaseMtime] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad' | 'info'; text: string } | null>(null);
  const [showCss, setShowCss] = useState(false);

  const mayWrite = hasRole(me, 'editor');

  // ── load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    if (!editing) {
      // A new theme starts from what is currently on screen. Seeding from a
      // fixed palette would put you on Bothy Dark while the page showed
      // something else, and the first thing you would do is undo that.
      setDraft({
        id: '', name: '', note: '', tokens: activeValues(names),
        appearance: document.documentElement.getAttribute('data-theme') === 'light'
          ? 'light' : 'dark',
      });
      return;
    }
    readFile(ROOT, dirOf(editing))
      .then((f) => {
        if (!alive) return;
        setDraft(fromCss(editing, f.content));
        // Carried so the save can send it back as baseMtime. Without it, two
        // tabs editing the same theme would silently overwrite each other -
        // the conflict check is the reason the write path is worth using.
        setBaseMtime(f.mtime);
      })
      .catch((e) => {
        if (!alive) return;
        setNotice({
          tone: 'bad',
          text: isAuthError(e) ? 'Your session expired. Sign in and reload.'
            : `Could not open ${dirOf(editing)} — ${e instanceof Error ? e.message : 'unknown error'}`,
        });
      });
    return () => { alive = false; };
  }, [editing, names]);

  // ── live preview ──────────────────────────────────────────────────────────
  //
  // Applied to the document element as inline custom properties, which beat any
  // stylesheet, so the whole app repaints as you drag a colour. Torn down on
  // unmount - and the teardown removes exactly the properties this page set,
  // rather than clearing style, because the shell sets its own (pane widths)
  // and wiping those would be a different bug.
  const applied = useRef<string[]>([]);
  useEffect(() => {
    if (!draft) return;
    const el = document.documentElement;
    for (const p of applied.current) el.style.removeProperty(p);
    const now: string[] = [];
    for (const [k, v] of Object.entries(draft.tokens)) {
      if (!v) continue;
      el.style.setProperty(k, v);
      now.push(k);
    }
    applied.current = now;
  }, [draft]);

  useEffect(() => () => {
    const el = document.documentElement;
    for (const p of applied.current) el.style.removeProperty(p);
    applied.current = [];
  }, []);

  // ── the contract, live ────────────────────────────────────────────────────
  const findings: Finding[] = useMemo(() => {
    if (!draft) return [];
    return evaluateTheme(draft.tokens, draft.appearance, { required: names });
  }, [draft, names]);
  const problems = findings.filter((f) => f.level === 'fail');

  const css = useMemo(() => (draft ? toCss(
    { ...draft, id: draft.id || slugify(draft.name) || 'untitled' }, names,
  ) : ''), [draft, names]);

  const set = useCallback((patch: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setNotice(null);
  }, []);
  const setToken = useCallback((k: string, v: string) => {
    setDraft((d) => (d ? { ...d, tokens: { ...d.tokens, [k]: v } } : d));
    setNotice(null);
  }, []);

  // ── save ──────────────────────────────────────────────────────────────────
  const save = async () => {
    if (!draft || busy) return;
    const id = draft.id || slugify(draft.name);
    if (!id) { setNotice({ tone: 'bad', text: 'Give the theme a name first.' }); return; }
    setBusy(true);
    setNotice(null);
    const out = await writeFile(
      ROOT, dirOf(id), toCss({ ...draft, id }, names),
      `theme: ${draft.name || id}`, baseMtime,
    );
    setBusy(false);
    switch (out.kind) {
      case 'saved':
        setBaseMtime(out.res.mtime);
        // Selecting it is the confirmation that it worked: the page you are
        // looking at is now painted by the FILE rather than by the preview.
        // A reload is what re-lists the directory, so the picker catches up.
        setSelection(id);
        setNotice({
          tone: 'ok',
          text: `Saved to ${dirOf(id)}. It is your active theme now; reload to see it in the picker.`,
        });
        if (!editing) nav(`/settings/theme/${id}`, { replace: true });
        break;
      case 'conflict':
        setNotice({
          tone: 'bad',
          text: 'The file changed on disk since this page opened it. Reload to pick up that version - saving now would discard it.',
        });
        break;
      case 'auth':
        setNotice({ tone: 'bad', text: 'Your session expired. Sign in and try again.' });
        break;
      default:
        setNotice({ tone: 'bad', text: out.message });
    }
  };

  // ── delete ────────────────────────────────────────────────────────────────
  //
  // Confirmed, and the confirmation says where the file goes rather than asking
  // "are you sure?" - the service snapshots the outgoing bytes first, so this is
  // recoverable, and saying so is more useful than a warning that is not true.
  const remove = async () => {
    if (!editing || busy) return;
    if (!confirm(
      `Delete ${dirOf(editing)}?\n\n`
      + 'The file is copied into the undo snapshot first, so it can be recovered '
      + 'from there.\n\nAnyone currently using this theme falls back to the default.',
    )) return;
    setBusy(true);
    const out = await deleteFile(ROOT, dirOf(editing), baseMtime);
    setBusy(false);
    if (out.kind === 'saved') {
      // Off this theme before it stops existing. Leaving the selection pointing
      // at a deleted file is survivable - resolveSelection falls back - but the
      // picker would show it selected until the next reload, which reads as the
      // delete not having worked.
      setSelection('bothy-dark');
      nav('/settings');
      return;
    }
    setNotice({
      tone: 'bad',
      text: out.kind === 'auth' ? 'Your session expired. Sign in and try again.'
        : 'message' in out ? out.message : 'The delete was refused.',
    });
  };

  if (!draft) {
    return (
      <div className="page theme-editor">
        <div className="page-head"><div><h1>Theme</h1></div></div>
        <p className="te-empty">{notice?.text ?? 'Loading…'}</p>
      </div>
    );
  }

  const id = draft.id || slugify(draft.name);

  return (
    <div className="page theme-editor">
      <div className="page-head">
        <div>
          <button type="button" className="te-back" onClick={() => nav('/settings')}>
            <ArrowLeft size={14} aria-hidden="true" /> Settings
          </button>
          <h1>{editing ? `Editing ${draft.name || editing}` : 'New theme'}</h1>
          <p className="page-sub">
            Every change is live on this page. Nothing is written until you save.
          </p>
        </div>
        <div className="te-actions">
          <button type="button" className="btn" onClick={() => setShowCss((v) => !v)}>
            <Code2 size={15} aria-hidden="true" /> {showCss ? 'Hide' : 'Show'} CSS
          </button>
          {editing && (
            <button
              type="button"
              className="btn te-danger"
              disabled={!mayWrite || busy}
              onClick={remove}
            >
              <Trash2 size={15} aria-hidden="true" /> Delete
            </button>
          )}
          <button type="button" className="btn primary" onClick={save} disabled={!mayWrite || busy}>
            <Save size={15} aria-hidden="true" /> {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {/* Role first, because it changes what the rest of the page can do. Absent
          rather than a disabled button with no explanation. */}
      {!mayWrite && (
        <p className="te-note te-warn">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>
            You can build and preview a theme here, but saving needs the <b>editor</b> role.
            Everything below still works — the preview is live — you just cannot write the file.
          </span>
        </p>
      )}

      {notice && (
        <p className={`te-note te-${notice.tone}`}>
          {notice.tone === 'ok' ? <Check size={15} /> : <AlertTriangle size={15} />}
          <span>{notice.text}</span>
        </p>
      )}

      <section className="panel">
        <h2 className="panel-h">Identity</h2>
        <div className="panel-b te-identity">
          <label className="te-field">
            <span>Name</span>
            <input
              type="text" value={draft.name} placeholder="Deep Ocean"
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
          <label className="te-field">
            <span>File</span>
            <input
              type="text" value={id} placeholder="deep-ocean"
              // The id is the filename AND a CSS selector, so it is normalised
              // as you type rather than validated on save - being told "that
              // name is invalid" after filling in a whole palette is the worst
              // possible moment to learn it.
              onChange={(e) => set({ id: slugify(e.target.value) })}
              disabled={!!editing}
            />
            <small>{dirOf(id || 'untitled')}</small>
          </label>
          <label className="te-field">
            <span>Appearance</span>
            <select
              value={draft.appearance}
              onChange={(e) => set({ appearance: e.target.value as 'dark' | 'light' })}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
            <small>Decides which base palette loads first, and the contrast rules applied below.</small>
          </label>
          <label className="te-field te-wide">
            <span>Note</span>
            <input
              type="text" value={draft.note} placeholder="One line, shown under the name in the picker."
              onChange={(e) => set({ note: e.target.value })}
            />
          </label>
        </div>
      </section>

      <Report findings={findings} problems={problems.length} />

      {showCss && (
        <section className="panel">
          <h2 className="panel-h">The file</h2>
          <div className="panel-b">
            <p className="set-note">
              This is exactly what gets written. Editing it here re-reads the tokens,
              so the form and the file cannot disagree.
            </p>
            <textarea
              className="te-css mono"
              value={css}
              spellCheck={false}
              onChange={(e) => {
                const next = fromCss(id || 'untitled', e.target.value);
                setDraft((d) => (d ? { ...d, ...next, id: d.id } : d));
              }}
            />
          </div>
        </section>
      )}

      {GROUPS.map((g) => (
        <section className="panel" key={g.title}>
          <h2 className="panel-h">{g.title}</h2>
          <div className="panel-b">
            <p className="set-note">{g.note}</p>
            <div className="te-grid">
              {g.tokens.filter((t) => names.includes(t)).map((t) => (
                <TokenField
                  key={t}
                  name={t}
                  value={draft.tokens[t] ?? ''}
                  bad={problems.some((p) => p.id.includes(t.replace(/^--/, '')))}
                  onChange={(v) => setToken(t, v)}
                />
              ))}
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}

/** One token. A colour well only when the value is a plain hex - a gradient, an
 *  rgba() or a shadow recipe would be silently destroyed by a colour input,
 *  which rewrites whatever it is given as #rrggbb. */
function TokenField({ name, value, bad, onChange }: {
  name: string; value: string; bad: boolean; onChange: (v: string) => void;
}) {
  const simple = isSimpleColour(value);
  return (
    <div className={`te-token ${bad ? 'is-bad' : ''}`}>
      <label className="te-token-name mono" htmlFor={`tok${name}`}>{name}</label>
      <div className="te-token-row">
        {simple && (
          <input
            type="color" value={value} aria-label={`${name} colour`}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        <input
          id={`tok${name}`}
          type="text" className="mono" value={value} spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}

/** The contract's verdict, live. Failures first and expanded; the passes are
 *  collapsed behind a count, because a wall of green is how a report stops being
 *  read - and the failures are the only rows anyone acts on. */
function Report({ findings, problems }: { findings: Finding[]; problems: number }) {
  const [all, setAll] = useState(false);
  const fails = findings.filter((f) => f.level === 'fail');
  const allows = findings.filter((f) => f.level === 'allow');
  const passes = findings.filter((f) => f.level === 'pass');

  return (
    <section className="panel">
      <h2 className="panel-h">
        Contrast and collisions
        <span className={`te-badge ${problems ? 'is-bad' : 'is-ok'}`}>
          {problems ? `${problems} to look at` : 'all clear'}
        </span>
      </h2>
      <div className="panel-b">
        <p className="set-note">
          The same rules Bothy holds its own themes to, run against yours as you type.
          They are advice here, not a gate — you can save a theme that breaks them.
        </p>
        {fails.map((f) => (
          <div className="te-finding is-fail" key={f.id}>
            <AlertTriangle size={14} aria-hidden="true" />
            <span><b>{f.label}</b> {f.detail}</span>
          </div>
        ))}
        {allows.map((f) => (
          <div className="te-finding is-allow" key={f.id}>
            <span><b>{f.label}</b> — {f.detail}</span>
          </div>
        ))}
        {passes.length > 0 && (
          <>
            <button type="button" className="te-more" onClick={() => setAll((v) => !v)}>
              {all ? 'Hide' : `Show ${passes.length}`} passing checks
            </button>
            {all && passes.map((f) => (
              <div className="te-finding is-pass" key={f.id}>
                <Check size={14} aria-hidden="true" />
                <span><b>{f.label}</b> {f.detail}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}
