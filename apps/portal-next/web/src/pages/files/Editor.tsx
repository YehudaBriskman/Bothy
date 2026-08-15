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
  AlertTriangle, CircleCheck, Code2, Download, Eye, FileDiff, FileDown, GitCommitVertical,
  Info, Keyboard, LoaderCircle, Lock, LogIn, Pencil, Save, Search, Undo2, X,
} from 'lucide-react';
import {
  fmtBytes, rawUrl, signInUrl, type DiffResult, type FileRead,
  type WriteConflict,
} from '../../lib/files';
import { ErrState, Skeleton } from '../../components/states';
import { Tooltip } from '../../components/Tooltip';
import { BothyMark } from '../../components/Brand';
import { BINDINGS, chordOf, EDITOR_KEYS } from './keys';
import { countLines, gutterText, GUTTER_LIMIT, highlight, willHighlight } from './highlight';
import { renderMd } from './md';
import { JsonView } from './JsonView';
import { baseName, dirName, type Kind } from './tree';
import { SignInCard } from './SignInCard';
import { DiffView, type DiffTarget } from './Diff';
import type { CodeHandle, CodeStat } from './CodeSurface';

// The whole of CodeMirror lives behind this one line. `npm run build` puts it in
// its own chunk, and the check that it STAYED there is the entry chunk's size
// beside it - see the note at the top of CodeSurface.tsx. Someone who never
// opens a file never downloads a byte of it.
const CodeSurface = lazy(() => import('./CodeSurface'));

export type View = 'preview' | 'source';

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

/** One chord, one `<span class="kbd">` per part. The parts come from keys.ts,
 *  so `Ctrl` vs `⌘` is decided in one place for every list that shows them. */
function Chord({ keys }: { keys: readonly string[] }) {
  return (
    <span className="fx-key-combo">
      {keys.map((k) => <span className="kbd" key={k}>{k}</span>)}
    </span>
  );
}

// ── nothing open ─────────────────────────────────────────────────────────────
//
// Borderless on purpose. A card would draw a box inside a pane that is already
// a box, and the state it is describing is not an error or an empty result -
// it is the ordinary starting position of the page.
//
// It teaches the keys because this is the one moment the centre column has
// nothing else to say, and because a shortcut nobody is told about has not
// shipped. Every row is read from the SAME table the handlers use (keys.ts) -
// a hand-written list here would be right today and wrong the first time a
// binding moves, and a reader cannot tell those two apart.
//
// The markup leans on classes that ALREADY have styles - `.fx-pad` for the
// scroll box, `.fx-key-combo` / `.fx-key-what` for the chords, `.dim` for the
// faded mark - so it reads correctly before a single new rule exists. The four
// `.fx-empty-*` hooks are for the two-column grid and the centring; without
// them this is a plain readable list rather than a broken one.
function NothingOpen() {
  return (
    <div className="fx-pad fx-empty">
      <span className="fx-empty-mark dim" aria-hidden="true"><BothyMark size={72} /></span>
      <div className="fx-empty-keys">
        {BINDINGS.map((b) => (
          <div className="fx-empty-key" key={b.id}>
            <Chord keys={b.keys} />{' '}
            <span className="fx-key-what">{b.what}</span>
          </div>
        ))}
      </div>
      <p className="fx-empty-hint dim">Pick a file on the left to begin.</p>
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
    // `tabIndex` is what makes a scrollable box reachable by keyboard at all -
    // and a tab stop with no role and no name is announced as nothing, so it
    // reads as a dead press. The role and the label are what turn it back into
    // a place you can be.
    <div className="fx-code scroll-shade" tabIndex={0} role="region" aria-label="File source">
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
  onEdit, onCancel, onSave, onClose, notice, dismissNotice, pending, pendingClose, resolvePending,
  conflict, onResolveConflict,
  diff, diffRes, diffLoading, diffErr, onDiffSide, onCloseDiff,
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
  /** Drop `path` from the URL and keep the root. Routed through the SAME
   *  dirty-guard as picking another file - see `pick` in Files.tsx - because
   *  the one thing a close button must never do is be the cheap way to lose an
   *  edit. */
  onClose: () => void;
  notice: Notice | null;
  conflict: WriteConflict | null;
  onResolveConflict: (choice: 'mine' | 'theirs' | 'dismiss') => void;
  dismissNotice: () => void;
  pending: boolean;
  /** The waiting navigation is a CLOSE rather than another file, so the banner
   *  can say what will actually happen. */
  pendingClose: boolean;
  resolvePending: (discard: boolean) => void;
  // ── the diff ───────────────────────────────────────────────────────────────
  // A TRANSIENT OVERLAY on the centre, not a navigation. Opening one does not
  // change which file is open, does not touch the URL, and does not disturb an
  // edit in progress - so a look at "what did I actually change" costs nothing
  // and can be closed back to exactly where you were.
  diff: DiffTarget | null;
  diffRes: DiffResult | null;
  diffLoading: boolean;
  diffErr: string | null;
  onDiffSide: (staged: boolean) => void;
  onCloseDiff: () => void;
  onDownload: () => void;
  canDownload: boolean;
  onFallback: (why: string) => void;
  editorRef: React.RefObject<CodeHandle | null>;
}) {
  const isMarkdown = lang === 'md';
  const isJson = lang === 'json';
  const [plain, setPlain] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const onFail = useCallback(() => setPlain(true), []);
  // A different file is a different document: a fresh undo stack, a fresh
  // scroll position and no search left over from the last one. Toggling Edit is
  // NOT a different document, which is why the key does not mention `editing` -
  // the surface flips a compartment and keeps where you were.
  const docKey = `${root}|${path}`;

  // ── the cursor readout, and who it belongs to ──────────────────────────────
  //
  // Stamped with the document it was measured on. It used to be a bare
  // `CodeStat`, set by the code surface and never cleared - so opening a .md
  // after a .ts left `Ln 42, Col 7` from the PREVIOUS file sitting in the
  // status strip, because markdown renders as an <article> and the surface that
  // owns those numbers is never mounted to correct them. A stale measurement
  // that looks live is the one kind of wrong a status strip must not be.
  const [stat, setStat] = useState<{ key: string; s: CodeStat } | null>(null);
  const onStat = useCallback((s: CodeStat) => setStat({ key: docKey, s }), [docKey]);

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

  // Is the code surface actually ON SCREEN? Three things in the status strip
  // are facts ABOUT that surface - the cursor readout, the Find button and the
  // Keys sheet - and none of them may outlive it. The old gate asked
  // `kind === 'text' && !plain`, which is true of a markdown file in Preview:
  // the buttons were there, `editorRef.current` was null, Find silently did
  // nothing and Keys listed shortcuts that were not bound to anything.
  //
  // This mirrors `body()` below, in its order. Anything that changes which
  // branch body() takes has to change here too - which is why it is written
  // once, beside it, rather than re-derived at each use.
  const codeMounted = !diff && !!path && !auth && !loading && !err && !!file
    && kind === 'text' && !plain
    && (editing || !(view === 'preview' && (isMarkdown || isJson)));
  const liveStat = codeMounted && stat && stat.key === docKey ? stat.s : null;

  const body = () => {
    // The diff wins over everything, including a file that is mid-edit: it was
    // asked for explicitly, and the edit is untouched underneath it.
    if (diff) return <DiffView target={diff} res={diffRes} loading={diffLoading} err={diffErr} />;
    if (!path) return <NothingOpen />;
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
        // `<article>` already carries a role, so it wants a NAME rather than a
        // second role - an unnamed tab stop is the defect, not the element.
        return (
          <article
            className="fx-read md scroll-shade"
            tabIndex={0}
            aria-label={`${baseName(file.path)} - rendered`}
          >
            {renderMd(file.content)}
          </article>
        );
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
          {diff ? (
            <>
              <FileDiff size={13} className="fx-crumb-ico" aria-hidden="true" />
              <span className="fx-crumb-dir">{diff.root}/{dirName(diff.path)}</span>
              <span className="fx-crumb-base">{baseName(diff.path)}</span>
              <span className="fx-crumb-tag">diff</span>
            </>
          ) : path ? (
            <>
              <span className="fx-crumb-dir">{root}/{dirName(path)}</span>
              <span className="fx-crumb-base">{baseName(path)}</span>
              {/* `role="img"` is what makes the name reachable. `aria-label` on
                  a bare <span> is ignored outright by screen readers - the
                  element has no role, so there is nothing for a name to name,
                  and the dot was announcing exactly nothing. */}
              {dirty && (
                <span className="fx-dot" role="img" aria-label="unsaved changes" title="unsaved changes" />
              )}
              {/* Close. There are no tabs on this page - one file at a time,
                  driven by ?root= / ?path= - so closing can only mean dropping
                  `path` and keeping the root. It goes through the same guard as
                  picking another file, so closing with unsaved edits raises the
                  banner rather than quietly discarding them. */}
              <Tooltip label="Close this file">
                <button
                  type="button"
                  className="fx-hbtn fx-crumb-x"
                  onClick={onClose}
                  aria-label={`Close ${baseName(path)}`}
                >
                  <X size={13} />
                </button>
              </Tooltip>
            </>
          ) : (
            <span className="fx-crumb-dir">{root || '…'}</span>
          )}
        </div>

        {/* ── the actions, as icons ───────────────────────────────────────────
            Every control here is a glyph plus a Tooltip plus an `aria-label`,
            which is the pattern the explorer header and the layout toggles
            already use - the strip is chrome, and chrome that spells itself out
            in words is chrome that keeps taking width from the file.

            SAVE IS THE EXCEPTION, deliberately. It is the one action in the row
            whose cost of being missed is unsaved work, and an unlabelled floppy
            is precisely where that goes wrong. It keeps its text.

            The tooltip opens DOWNWARD (components/Tooltip.tsx: no portal, no
            collision logic) which is fine here - this strip is at the TOP. The
            same treatment is refused in the status strip at the bottom, where
            the bubble would open off-screen. */}
        <div className="fx-actions">
          {diff && (
            <>
              {/* Both sides of the staging line, from one row. They are
                  genuinely different diffs - working tree against the index,
                  and the index against HEAD - and which one you are looking at
                  is the single most confusable thing about a diff. */}
              <div className="seg-toggle fx-seg fx-seg-ico" role="group" aria-label="Diff side">
                <Tooltip label="Working tree, against the index">
                  <button
                    type="button"
                    className={!diff.staged ? 'on' : ''}
                    aria-pressed={!diff.staged}
                    aria-label="Working tree, against the index"
                    onClick={() => onDiffSide(false)}
                  >
                    <Pencil size={13} aria-hidden="true" />
                  </button>
                </Tooltip>
                <Tooltip label="Staged, against HEAD">
                  <button
                    type="button"
                    className={diff.staged ? 'on' : ''}
                    aria-pressed={diff.staged}
                    aria-label="Staged, against HEAD"
                    onClick={() => onDiffSide(true)}
                  >
                    <GitCommitVertical size={13} aria-hidden="true" />
                  </button>
                </Tooltip>
              </div>
              <Tooltip label="Close the diff" align="end">
                <button type="button" className="fx-hbtn" onClick={onCloseDiff} aria-label="Close the diff">
                  <X size={14} />
                </button>
              </Tooltip>
            </>
          )}
          {!diff && showSwitcher && (
            <div className="seg-toggle fx-seg fx-seg-ico" role="group" aria-label="View">
              <Tooltip label={isMarkdown ? 'Preview - rendered markdown' : 'Preview - folded JSON'}>
                <button
                  type="button"
                  className={view === 'preview' ? 'on' : ''}
                  aria-pressed={view === 'preview'}
                  aria-label="Preview"
                  onClick={() => setView('preview')}
                >
                  <Eye size={13} aria-hidden="true" />
                </button>
              </Tooltip>
              <Tooltip label="Source - the text itself">
                <button
                  type="button"
                  className={view === 'source' ? 'on' : ''}
                  aria-pressed={view === 'source'}
                  aria-label="Source"
                  onClick={() => setView('source')}
                >
                  <Code2 size={13} aria-hidden="true" />
                </button>
              </Tooltip>
            </div>
          )}
          {/* No Save button on a file that can only be refused. */}
          {!diff && file && editable && !editing && (
            <Tooltip label="Edit this file" align="end">
              <button type="button" className="fx-hbtn" onClick={onEdit} aria-label="Edit this file">
                <Pencil size={14} />
              </button>
            </Tooltip>
          )}
          {!diff && editing && (
            <>
              <Tooltip label="Cancel - restore the saved text">
                <button
                  type="button"
                  className="fx-hbtn"
                  onClick={onCancel}
                  disabled={saving}
                  aria-label="Cancel the edit and restore the saved text"
                >
                  <Undo2 size={14} />
                </button>
              </Tooltip>
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
          <span>
            <b>{baseName(file.path)}</b> has unsaved changes.{' '}
            {pendingClose ? 'Closing it discards them.' : 'Opening another file discards them.'}
          </span>
          <span className="fx-note-actions">
            <button type="button" className="btn ghost sm" onClick={() => resolvePending(false)}>Keep editing</button>
            <button type="button" className="btn sm" onClick={() => resolvePending(true)}>
              {pendingClose ? 'Discard and close' : 'Discard and open'}
            </button>
          </span>
        </div>
      )}

      {conflict && (
        // The stale-save case. Deliberately NOT auto-resolved and deliberately
        // not dismissible by accident: the whole reason the server refuses this
        // write is that picking a winner silently is how work disappears. Both
        // versions are in hand, so the choice is offered explicitly.
        <div className="fx-conflict" role="alert">
          <div className="fx-conflict-h">
            <AlertTriangle size={15} aria-hidden="true" />
            <strong>This file changed on disk since you opened it.</strong>
            <span className="dim">Nothing was overwritten.</span>
          </div>
          <p className="fx-conflict-p">
            Yours is {conflict.yours.length} characters; the version on disk is{' '}
            {conflict.theirs.length}.
          </p>
          <div className="fx-conflict-actions">
            <button type="button" className="btn sm primary" onClick={() => onResolveConflict('mine')}>
              Keep mine, overwrite disk
            </button>
            <button type="button" className="btn sm" onClick={() => onResolveConflict('theirs')}>
              Take the disk version, discard mine
            </button>
            <button type="button" className="btn sm ghost" onClick={() => onResolveConflict('dismiss')}>
              Leave it for now
            </button>
          </div>
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
      {keysOpen && codeMounted && (
        <div className="fx-keys" role="group" aria-label="Editor keys" id="fx-keys-sheet">
          {EDITOR_KEYS.map((b) => (
            <span className="fx-key" key={b.id}>
              <Chord keys={b.keys} />
              <span className="fx-key-what">{b.what}</span>
            </span>
          ))}
        </div>
      )}

      {/* The status strip. Everything that used to be a tag scattered through
          the header, in the one place an editor puts it - so the header can be
          about the file's identity and its actions, and nothing else. */}
      <footer className="fx-status">
        {diff ? (
          // The diff is an overlay, so the strip stops describing the file
          // underneath it - a byte count and a line count that belong to a
          // different document than the one on screen is worse than none.
          <>
            <span className="fx-stat">{diff.staged ? 'staged, against HEAD' : 'working tree, against the index'}</span>
            <span className="fx-stat-sep" aria-hidden="true" />
            {/* NOT `.fx-stat.mono` - that class uppercases, which is right for
                a three-letter language chip and wrong for a path. */}
            <span className="fx-stat fx-diffpath">{diff.path}</span>
            <span className="fx-status-spacer" />
            {dirty && <span className="fx-stat warn">the editor still holds unsaved changes</span>}
          </>
        ) : file ? (
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

            {liveStat && (
              <>
                <span className="fx-stat-sep" aria-hidden="true" />
                <span className="fx-stat tnum">Ln {liveStat.line}, Col {liveStat.col}</span>
                {liveStat.sel > 0 && <span className="fx-stat tnum">{liveStat.sel.toLocaleString()} selected</span>}
                {liveStat.cursors > 1 && <span className="fx-stat tnum">{liveStat.cursors} cursors</span>}
                {liveStat.find && (
                  <span className={`fx-stat tnum ${liveStat.find.n === 0 || liveStat.find.n < 0 ? 'warn' : ''}`}>
                    {!liveStat.find.q
                      ? 'find: type to search'
                      : liveStat.find.n < 0
                        ? 'find: bad pattern'
                        : `${liveStat.find.capped ? `${liveStat.find.n.toLocaleString()}+` : liveStat.find.n.toLocaleString()} `
                          + `${liveStat.find.n === 1 ? 'match' : 'matches'}`}
                  </span>
                )}
              </>
            )}

            <span className="fx-status-spacer" />
            {/* Both of these are about the CODE SURFACE, so both are gated on it
                actually being mounted. In Preview they used to be present and
                dead: `editorRef.current` is null with no surface under it, so
                Find did nothing at all and Keys listed shortcuts that were not
                bound to anything. Hidden rather than made to switch to Source
                first - a button that silently changes what you are looking at
                is a second surprise on top of the first, and the Preview/Source
                switcher is two inches away in the header.

                `title`, not <Tooltip>: this strip is at the BOTTOM of the pane
                and the tooltip has no collision logic - it always opens
                downward, which here is off-screen. Same reason ActivityBar.tsx
                gives for refusing it. */}
            {codeMounted && (
              <>
                <button
                  type="button"
                  className="fx-statbtn"
                  onClick={() => editorRef.current?.openFind()}
                  aria-label={`Find in this file (${chordOf('find').join(' ')})`}
                  title={`Find in this file - ${chordOf('find').join(' ')}`}
                >
                  <Search size={11} aria-hidden="true" /> Find
                </button>
                <button
                  type="button"
                  className={`fx-statbtn ${keysOpen ? 'on' : ''}`}
                  onClick={() => setKeysOpen((v) => !v)}
                  aria-expanded={keysOpen}
                  aria-controls="fx-keys-sheet"
                  title="Every key this editor binds"
                >
                  <Keyboard size={11} aria-hidden="true" /> Keys
                </button>
              </>
            )}
            {editing && (
              <span className="fx-stat"><Chord keys={chordOf('save')} /> saves</span>
            )}
          </>
        ) : (
          <span className="fx-stat">no file open</span>
        )}
      </footer>
    </section>
  );
}
