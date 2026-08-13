// ── the centre column ────────────────────────────────────────────────────────
//
// The only region that changes MODE. Everything else here asks a fixed question;
// this one asks "what is in this file", and the honest answer depends entirely
// on what the file is.
//
// Six answers, and the switcher only ever offers the ones that exist:
//
//   markdown  Preview (rendered) | Source (highlighted)
//   json      Preview (folded)   | Source (highlighted)
//   image     Preview (rendered) - there is no text to show
//   pdf       a download card, because the sandbox origin serves PDF as an
//             ATTACHMENT and no frame can render it (see RawFrame)
//   other binary  a download card with the size and the reason
//   text/code Source, with a line-number gutter
//
// The previous version offered a switcher to markdown alone, so JSON, images and
// PDFs all landed on the same dead end. That is the regression this file exists
// to undo.

import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, CircleCheck, Code2, Download, Eye, FileDown, Info, Keyboard, LoaderCircle,
  Lock, LogIn, Pencil, Save, Search, Undo2, X,
} from 'lucide-react';
import {
  fmtBytes, rawUrl, signInUrl, type FileRead,
} from '../../lib/files';
import { EmptyState, ErrState, Skeleton } from '../../components/states';
import { Tooltip } from '../../components/Tooltip';
import { countLines, gutterText, GUTTER_LIMIT, highlight, willHighlight } from './highlight';
import { renderMd } from './md';
import { JsonView } from './JsonView';
import { baseName, dirName, type Kind } from './tree';
import { SignInCard } from './SignInCard';
import type { CodeHandle, CodeStat } from './CodeSurface';

// The whole of CodeMirror lives behind this one line. `npm run build` puts it in
// its own chunk, and the check that it STAYED there is the entry chunk's size
// beside it - see the note at the top of CodeSurface.tsx. Someone who never
// opens a file never downloads a byte of it.
const CodeSurface = lazy(() => import('./CodeSurface'));

export type View = 'preview' | 'source';

// Shown by the Keys button in the status strip. Every one of these is really
// bound - the first five by @codemirror/{commands,search}, the two mouse ones by
// the facets CodeSurface.tsx sets, and the last is the ABSENCE of a binding:
// Tab is deliberately unbound so the editor is not a keyboard trap.
const KEYS: [string, string][] = [
  ['Ctrl+S', 'save'],
  ['Ctrl+F', 'find and replace'],
  ['Ctrl+D', 'select next match'],
  ['Alt+↑ / ↓', 'move the line'],
  ['Ctrl+/', 'toggle comment'],
  ['Ctrl+Z / Y', 'undo / redo'],
  ['Alt+click', 'add a caret'],
  ['Alt+Shift+drag', 'column select'],
  ['Tab', 'leaves the editor'],
];

export type Notice =
  | { tone: 'ok'; text: string }
  | { tone: 'info'; text: string }
  | { tone: 'bad'; text: string }
  | { tone: 'auth' };

// ── raw bytes in the page ────────────────────────────────────────────────────
//
// An <img> pointed at the sandbox origin is the correct shape and is what this
// renders first. It is currently BLOCKED, and the block is worth writing down
// because it is invisible from the server side: :8100 answers raw bytes with
//
//     Cross-Origin-Resource-Policy: same-origin
//
// and a port is part of an origin, so the portal on :80 fails that check.
// Chromium refuses the load with ERR_BLOCKED_BY_RESPONSE.NotSameOrigin - not a
// CSP error, not a CORS error, and nothing appears in the network tab as a
// failure status, because the response arrived fine and was then discarded.
// `same-site` is the value that expresses what that header is actually for here
// (ports are not part of a site, so :80 and :8100 are same-site while remaining
// different origins) and is a one-word change in portal-files.
//
// Until then: a frame. A frame is a NAVIGATION, not a subresource fetch, and
// CORP does not apply to navigations - measured, both ways, in Chromium against
// the live service. The isolation is unchanged: the framed document is still on
// :8100, still carries `CSP: default-src 'none'; sandbox`, and still cannot
// touch this document. What is lost is only fit-to-window sizing, because the
// frame shows the browser's own image viewer at natural size.
//
// So: try the <img>, fall back to the frame, and say which one happened. When
// the header is fixed the good path lights up with no code change.
function RawPreview({ src, name, onFallback }: {
  src: string; name: string; onFallback: (why: string) => void;
}) {
  const [mode, setMode] = useState<'img' | 'frame'>('img');
  // A new file is a new attempt - otherwise one blocked image would pin every
  // later one to the frame for the life of the page.
  useEffect(() => { setMode('img'); }, [src]);

  if (mode === 'frame') {
    return (
      <div className="fx-media-wrap">
        {/* The degraded path is LABELLED. A frame shows the browser's own image
            viewer, which paints at natural size and crops rather than fitting -
            so without this strip the reader sees the top-left corner of their
            image and has no way to tell a rendering limitation from a broken
            file. Saying which of the two it is costs one line. */}
        <p className="fx-media-note">
          Shown in a frame at natural size - click it to zoom. The sandbox origin
          is refusing to be embedded directly; the Inspector&apos;s <b>Raw</b> download
          is the full-size copy.
        </p>
        <div className="fx-media fx-media-frame">
          <iframe
            className="fx-media-iframe"
            src={src}
            title={`${name} - rendered on the sandbox origin`}
            // No `sandbox` attribute is needed or wanted: the RESPONSE already
            // carries `Content-Security-Policy: sandbox`, which is the same
            // restriction applied by the side that owns the bytes rather than by
            // the side that is trying to be safe from them.
          />
        </div>
      </div>
    );
  }
  return (
    <div className="fx-media">
      <img
        className="fx-media-img"
        src={src}
        alt={name}
        onError={() => {
          setMode('frame');
          onFallback('the sandbox origin refused to be embedded (Cross-Origin-Resource-Policy: same-origin); '
            + 'showing it in a frame instead');
        }}
      />
    </div>
  );
}

function DownloadCard({ file, kind, onDownload, canDownload }: {
  file: FileRead; kind: Kind; onDownload: () => void; canDownload: boolean;
}) {
  const isPdf = kind === 'pdf';
  return (
    <div className="fx-binary">
      <span className="fx-binary-ico"><FileDown size={22} aria-hidden="true" /></span>
      <h4>{isPdf ? 'PDF' : 'Binary file'}</h4>
      <p className="fx-binary-facts">
        <span className="mono">{baseName(file.path)}</span>
        <span aria-hidden="true">·</span>
        <span>{fmtBytes(file.size)}</span>
      </p>
      <p>
        {isPdf
          // Stated as a property of the service, not as a shrug. The reader can
          // check it, and it tells whoever changes the backend what to change.
          ? <>The file service serves PDF as an <b>attachment</b> on the sandbox origin,
              so nothing here can render it inline. Downloading it opens it in the
              browser&apos;s own viewer, which is the same reader with none of the risk.</>
          : <>These bytes are not text. It is listed because it is in the root;
              dumping the bytes into a viewer would help nobody.</>}
      </p>
      <button type="button" className="btn primary" onClick={onDownload} disabled={!canDownload}>
        <Download size={14} aria-hidden="true" /> Download
      </button>
      {!canDownload && <p className="fx-binary-note">Sign in first - the download origin has no sign-in page of its own.</p>}
    </div>
  );
}

// ── the plain surfaces ───────────────────────────────────────────────────────
//
// These are what the page WAS, kept for exactly two jobs: the instant between
// the code-editor chunk being asked for and arriving, and the case where that
// chunk never arrives at all. A file with unsaved edits must not become a blank
// rectangle because a network hiccup ate a script, so the fallback is a real
// textarea that can still be typed into and still be saved.
//
// Both the gutter and the highlight are memoised on the source string. In the
// read-only view that only matters once per file; in the EDITOR it is the
// difference between typing being free and every keystroke rebuilding an array
// of N strings - 20,000 allocations per character on a large file.
function Source({ src, lang }: { src: string; lang: string }) {
  const gutter = useMemo(() => {
    const lines = countLines(src);
    return lines <= GUTTER_LIMIT ? gutterText(lines) : null;
  }, [src]);
  return (
    <div className="fx-code scroll-shade" tabIndex={0}>
      {gutter && <pre className="fx-gutter" aria-hidden="true">{gutter}</pre>}
      <pre className="fx-src"><code>{highlight(src, lang)}</code></pre>
    </div>
  );
}

// The textarea keeps its gutter in sync by hand, because a textarea's scroll
// position is not observable through React state at 60fps - and putting it in
// state would re-render the whole centre on every wheel notch.
function EditSurface({ draft, setDraft, handleRef }: {
  draft: string;
  setDraft: (v: string) => void;
  handleRef: React.RefObject<CodeHandle | null>;
}) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLPreElement | null>(null);
  // Recomputed only when the LINE COUNT changes, not on every keystroke: typing
  // inside a line leaves the gutter identical, and that is the common case.
  const lines = useMemo(() => countLines(draft), [draft]);
  const gutter = useMemo(() => (lines <= GUTTER_LIMIT ? gutterText(lines) : null), [lines]);
  const sync = useCallback(() => {
    if (gutterRef.current && taRef.current) gutterRef.current.scrollTop = taRef.current.scrollTop;
  }, []);

  // The same imperative handle the CodeMirror surface publishes, so `startEdit`
  // in Files.tsx focuses whichever one is actually mounted. `openFind` has no
  // honest answer here, so it says so by doing nothing rather than by pretending.
  useEffect(() => {
    handleRef.current = { focus: () => taRef.current?.focus(), openFind: () => {} };
    return () => { handleRef.current = null; };
  }, [handleRef]);

  return (
    <div className="fx-code fx-code-edit">
      {gutter && <pre className="fx-gutter" ref={gutterRef} aria-hidden="true">{gutter}</pre>}
      <label className="sr-only" htmlFor="files-editor">File contents</label>
      <textarea
        id="files-editor"
        ref={taRef}
        className="fx-textarea"
        value={draft}
        spellCheck={false}
        onScroll={sync}
        onChange={(e) => setDraft(e.target.value)}
      />
    </div>
  );
}

function PlainSurface(p: {
  src: string; lang: string; editing: boolean;
  draft: string; setDraft: (v: string) => void;
  handleRef: React.RefObject<CodeHandle | null>;
}) {
  return p.editing
    ? <EditSurface draft={p.draft} setDraft={p.setDraft} handleRef={p.handleRef} />
    : <Source src={p.src} lang={p.lang} />;
}

// A failed chunk load is not an exception React can recover from on its own, and
// the default is a blank centre column - on a page that may be holding unsaved
// work. This pins the session to the plain surfaces and SAYS which of the two
// the reader is looking at, because "my editor lost its line highlight" with no
// explanation is a bug report.
class CodeBoundary extends Component<
  { children: React.ReactNode; fallback: React.ReactNode; onFail: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch() { this.props.onFail(); }

  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export function Editor({
  root, path, file, kind, lang, loading, err, auth, onRetryOpen,
  view, setView, editing, draft, setDraft, dirty, saving, editable,
  onEdit, onCancel, onSave, notice, dismissNotice, pending, resolvePending,
  onDownload, canDownload, onFallback, editorRef,
}: {
  root: string;
  path: string;
  file: FileRead | null;
  kind: Kind;
  lang: string;
  loading: boolean;
  err: string | null;
  auth: boolean;
  onRetryOpen: () => void;
  view: View;
  setView: (v: View) => void;
  editing: boolean;
  draft: string;
  setDraft: (v: string) => void;
  dirty: boolean;
  saving: boolean;
  editable: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  notice: Notice | null;
  dismissNotice: () => void;
  pending: boolean;
  resolvePending: (discard: boolean) => void;
  onDownload: () => void;
  canDownload: boolean;
  onFallback: (why: string) => void;
  editorRef: React.RefObject<CodeHandle | null>;
}) {
  const isMarkdown = lang === 'md';
  const isJson = lang === 'json';
  const [stat, setStat] = useState<CodeStat | null>(null);
  const [plain, setPlain] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const onStat = useCallback((s: CodeStat) => setStat(s), []);
  const onFail = useCallback(() => setPlain(true), []);
  // A different file is a different document: a fresh undo stack, a fresh
  // scroll position and no search left over from the last one. Toggling Edit is
  // NOT a different document, which is why the key does not mention `editing` -
  // the surface flips a compartment and keeps where you were.
  const docKey = `${root}|${path}`;

  // The status strip's two measurements, memoised for the same reason the gutter
  // is: `new Blob([draft]).size` copies the whole string, and doing that on every
  // keystroke of a 1 MB file (the service's read ceiling) is a megabyte of
  // allocation per character typed. TextEncoder's byte length is the same
  // answer without the Blob.
  const shown = editing ? draft : (file?.content ?? '');
  const byteSize = useMemo(
    () => (editing ? new TextEncoder().encode(shown).length : (file?.size ?? 0)),
    [editing, shown, file],
  );
  const lineCount = useMemo(() => (shown ? countLines(shown) : 0), [shown]);
  // Only formats with a genuine rendered form get a switcher. A shell script has
  // no "preview", and a toggle that swaps highlighted text for the same text is
  // a control that does nothing.
  const previewable = kind === 'image' || isMarkdown || isJson;
  const showSwitcher = !editing && previewable && kind !== 'image';

  const body = () => {
    if (!path) {
      return (
        <div className="fx-pad">
          <EmptyState
            message="No file open"
            hint="Pick one on the left, or search for a path. Browsing needs the viewer role; saving needs editor."
          />
        </div>
      );
    }
    if (auth) return <div className="fx-pad"><SignInCard what="read this file" onRetry={onRetryOpen} /></div>;
    if (loading) return <div className="fx-pad"><Skeleton variant="table" /></div>;
    if (err || !file) {
      return (
        <div className="fx-pad">
          <ErrState
            title="Could not open that file"
            body={`${root}/${path} - ${err ?? 'no content came back'}`}
            onRetry={onRetryOpen}
          />
        </div>
      );
    }
    // Everything that is NOT text, and the two rendered views of text, first -
    // they are unaffected by which text surface is in use.
    if (!editing) {
      if (kind === 'image') {
        return <RawPreview src={rawUrl(root, file.path)} name={baseName(file.path)} onFallback={onFallback} />;
      }
      if (kind === 'pdf' || kind === 'binary') {
        return <DownloadCard file={file} kind={kind} onDownload={onDownload} canDownload={canDownload} />;
      }
      if (view === 'preview' && isMarkdown) {
        return <article className="fx-read md scroll-shade" tabIndex={0}>{renderMd(file.content)}</article>;
      }
      if (view === 'preview' && isJson) return <JsonView src={file.content} />;
    }

    const fallback = (
      <PlainSurface
        src={file.content} lang={lang} editing={editing}
        draft={draft} setDraft={setDraft} handleRef={editorRef}
      />
    );
    if (plain) return fallback;

    // ONE surface for Source and Edit. A read-only file is this same editor with
    // `EditorState.readOnly` set - it reports `aria-readonly`, refuses every
    // write, and keeps the caret, the search panel and the line highlights that
    // a `<pre>` cannot have.
    return (
      <CodeBoundary fallback={fallback} onFail={onFail}>
        <Suspense fallback={fallback}>
          <CodeSurface
            key={docKey}
            value={editing ? draft : file.content}
            lang={lang}
            editable={editing}
            onChange={setDraft}
            onStat={onStat}
            handleRef={editorRef}
            label={`${baseName(file.path)} - ${editing ? 'editable' : 'read-only'}`}
          />
        </Suspense>
      </CodeBoundary>
    );
  };

  return (
    <section className="fx-centre" aria-label="File">
      <header className="fx-tabbar">
        <div className="fx-crumb">
          {path ? (
            <>
              <span className="fx-crumb-dir">{root}/{dirName(path)}</span>
              <span className="fx-crumb-base">{baseName(path)}</span>
              {dirty && <span className="fx-dot" aria-label="unsaved changes" title="unsaved changes" />}
            </>
          ) : (
            <span className="fx-crumb-dir">{root || '…'}</span>
          )}
        </div>

        <div className="fx-actions">
          {showSwitcher && (
            <div className="seg-toggle fx-seg" role="group" aria-label="View">
              <button
                type="button"
                className={view === 'preview' ? 'on' : ''}
                aria-pressed={view === 'preview'}
                onClick={() => setView('preview')}
              >
                <Eye size={13} aria-hidden="true" /> Preview
              </button>
              <button
                type="button"
                className={view === 'source' ? 'on' : ''}
                aria-pressed={view === 'source'}
                onClick={() => setView('source')}
              >
                <Code2 size={13} aria-hidden="true" /> Source
              </button>
            </div>
          )}
          {/* No Save button on a file that can only be refused. */}
          {file && editable && !editing && (
            <button type="button" className="btn sm" onClick={onEdit}>
              <Pencil size={13} aria-hidden="true" /> Edit
            </button>
          )}
          {editing && (
            <>
              <button type="button" className="btn ghost sm" onClick={onCancel} disabled={saving}>
                <Undo2 size={13} aria-hidden="true" /> Cancel
              </button>
              <button type="button" className="btn primary sm" onClick={onSave} disabled={saving}>
                {saving
                  ? <LoaderCircle size={13} className="spin" aria-hidden="true" />
                  : <Save size={13} aria-hidden="true" />}
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        </div>
      </header>

      {pending && file && (
        <div className="fx-note warn" role="alert">
          <AlertTriangle size={15} aria-hidden="true" />
          <span><b>{baseName(file.path)}</b> has unsaved changes. Opening another file discards them.</span>
          <span className="fx-note-actions">
            <button type="button" className="btn ghost sm" onClick={() => resolvePending(false)}>Keep editing</button>
            <button type="button" className="btn sm" onClick={() => resolvePending(true)}>Discard and open</button>
          </span>
        </div>
      )}

      {notice && (
        // A live region rather than a toast: this product has no toast layer
        // (brand/patterns/feedback.md) and an outcome you can still read beats
        // one that has already faded.
        <div className={`fx-note ${notice.tone}`} role="status">
          {notice.tone === 'ok' && <CircleCheck size={15} aria-hidden="true" />}
          {notice.tone === 'info' && <Info size={15} aria-hidden="true" />}
          {notice.tone === 'bad' && <AlertTriangle size={15} aria-hidden="true" />}
          {notice.tone === 'auth' && <LogIn size={15} aria-hidden="true" />}
          {notice.tone === 'auth' ? (
            <>
              <span>Saving needs the editor role. Your edits stay in this tab.</span>
              <span className="fx-note-actions">
                <a className="btn sm" href={signInUrl()}>Sign in, then Save again</a>
              </span>
            </>
          ) : (
            <>
              <span>{notice.text}</span>
              <span className="fx-note-actions">
                <button type="button" className="icon-btn sm" aria-label="Dismiss" onClick={dismissNotice}>
                  <X size={14} />
                </button>
              </span>
            </>
          )}
        </div>
      )}

      {plain && file && kind === 'text' && (
        <div className="fx-note info" role="status">
          <Info size={15} aria-hidden="true" />
          <span>
            The code editor did not load, so this is the plain text surface -
            no line highlight, no find panel, no multiple cursors. Editing and
            saving are unaffected. Reloading the page retries it.
          </span>
        </div>
      )}

      <div className="fx-body">{body()}</div>

      {/* The hotkeys, written down. An editor whose features are only reachable
          by knowing they exist has not shipped them - and the two that are least
          guessable (Alt-click for a second caret, Alt-Shift-drag for a column)
          are exactly the two nothing else on the page hints at. */}
      {keysOpen && kind === 'text' && !plain && (
        <div className="fx-keys" role="group" aria-label="Editor keys">
          {KEYS.map(([keys, what]) => (
            <span className="fx-key" key={what}>
              <span className="fx-key-combo">
                {keys.split('+').map((k) => <span className="kbd" key={k}>{k}</span>)}
              </span>
              <span className="fx-key-what">{what}</span>
            </span>
          ))}
        </div>
      )}

      {/* The status strip. Everything that used to be a tag scattered through
          the header, in the one place an editor puts it - so the header can be
          about the file's identity and its actions, and nothing else. */}
      <footer className="fx-status">
        {file ? (
          <>
            {editing
              ? <span className={`fx-stat ${dirty ? 'warn' : ''}`}>{dirty ? 'unsaved changes' : 'editing - no changes yet'}</span>
              : editable
                ? <span className="fx-stat">writable</span>
                : (
                  <Tooltip label="The file service will not accept writes to this path - it is outside the writable set, or this session has viewer but not editor.">
                    <span className="fx-stat"><Lock size={10} aria-hidden="true" /> read-only</span>
                  </Tooltip>
                )}
            <span className="fx-stat-sep" aria-hidden="true" />
            {/* The SERVICE's label, not the highlighter's ruleset. They differ:
                a justfile is labelled `make` and coloured with the shell rules,
                and a strip saying SH beside an inspector saying make is two
                answers to one question. The ruleset is an implementation
                detail; the label is the file's identity. */}
            {(file.lang || lang) && <span className="fx-stat mono">{file.lang || lang}</span>}
            <span className="fx-stat tnum">{fmtBytes(byteSize)}</span>
            {kind === 'text' && <span className="fx-stat tnum">{lineCount.toLocaleString()} lines</span>}
            {/* Only the plain surface has a size ceiling. CodeMirror renders the
                viewport and nothing else, so document LENGTH stops mattering to
                it and the chip would be saying something untrue. */}
            {plain && kind === 'text' && !editing && !willHighlight(file.content, lang) && lang && (
              <span className="fx-stat">highlighting off - too large</span>
            )}

            {kind === 'text' && !plain && stat && (
              <>
                <span className="fx-stat-sep" aria-hidden="true" />
                <span className="fx-stat tnum">Ln {stat.line}, Col {stat.col}</span>
                {stat.sel > 0 && <span className="fx-stat tnum">{stat.sel.toLocaleString()} selected</span>}
                {stat.cursors > 1 && <span className="fx-stat tnum">{stat.cursors} cursors</span>}
                {stat.find && (
                  <span className={`fx-stat tnum ${stat.find.n === 0 || stat.find.n < 0 ? 'warn' : ''}`}>
                    {!stat.find.q
                      ? 'find: type to search'
                      : stat.find.n < 0
                        ? 'find: bad pattern'
                        : `${stat.find.capped ? `${stat.find.n.toLocaleString()}+` : stat.find.n.toLocaleString()} `
                          + `${stat.find.n === 1 ? 'match' : 'matches'}`}
                  </span>
                )}
              </>
            )}

            <span className="fx-status-spacer" />
            {kind === 'text' && !plain && (
              <>
                <button
                  type="button"
                  className="fx-statbtn"
                  onClick={() => editorRef.current?.openFind()}
                  aria-label="Find in this file (Ctrl F)"
                >
                  <Search size={11} aria-hidden="true" /> Find
                </button>
                <button
                  type="button"
                  className={`fx-statbtn ${keysOpen ? 'on' : ''}`}
                  onClick={() => setKeysOpen((v) => !v)}
                  aria-expanded={keysOpen}
                >
                  <Keyboard size={11} aria-hidden="true" /> Keys
                </button>
              </>
            )}
            {editing && <span className="fx-stat"><span className="kbd">Ctrl</span> <span className="kbd">S</span> saves</span>}
          </>
        ) : (
          <span className="fx-stat">no file open</span>
        )}
      </footer>
    </section>
  );
}
