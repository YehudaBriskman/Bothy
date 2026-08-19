// ── the centre column: one EDITOR GROUP ──────────────────────────────────────
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
//   pdf/svg/html/video  the sandbox frame, which /raw already serves inline
//   other binary  a download card with the size and the reason
//   text/code Source, with a line-number gutter
//
// ── WHAT CHANGED WITH TABS ───────────────────────────────────────────────────
//
// This file used to render ONE document, handed to it as `file`/`draft`/
// `editing` props. It now renders a GROUP: an ordered list of open documents,
// one of which is active. Files.tsx owns the list; this owns the strip, the
// stack and the status.
//
// The stack is the load-bearing part. EVERY document in the group is mounted at
// all times and the inactive ones are `hidden`; only the active one is painted.
// That is not tidiness - it is the whole reason undo survives a tab switch.
// CodeMirror's history lives in its EditorState, which dies with the view, and
// the view is keyed per document. Unmounting the losers on every switch is
// exactly the behaviour a document model exists to remove. The cost is one
// EditorView per open tab, which is the same cost every editor with tabs pays.
//
// The diff is an OVERLAY on that stack rather than a replacement for it, for the
// same reason: it used to `return` before the surfaces were rendered, so opening
// a diff over a file mid-edit and closing it again cost you your undo stack.

import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, CircleCheck, Code2, Columns2, Crosshair, Download, Eye, FileArchive,
  GitCommitVertical, Info, Keyboard, LoaderCircle, Lock, LogIn, Pencil,
  Save, Search, Undo2, X,
} from 'lucide-react';
import {
  fmtBytes, langFor, looksBinary, rawUrl, signInUrl,
  type DiffResult, type FileRead, type WriteConflict,
} from '../../lib/files';
import { ErrState, Skeleton } from '../../components/states';
import { Tooltip } from '../../components/Tooltip';
import { BothyMark } from '../../components/Brand';
import { chordOf, EDITOR_KEYS, STARTER_KEYS } from './keys';
import { countLines, gutterText, GUTTER_LIMIT, willHighlight } from './highlight';
import { FileContent, Source, type View } from './FileContent';
import { baseName, dirName, isFramedText, kindOf, type Kind } from './tree';
import { SignInCard } from './SignInCard';
import { DiffView, type DiffTarget } from './Diff';
import { OverflowMenu, type MenuItem } from './Menu';
import type { CodeHandle, CodeStat } from './CodeSurface';

// The whole of CodeMirror lives behind this one line. `npm run build` puts it in
// its own chunk, and the check that it STAYED there is the entry chunk's size
// beside it - see the note at the top of CodeSurface.tsx. Someone who never
// opens a file never downloads a byte of it.
const CodeSurface = lazy(() => import('./CodeSurface'));

// Moved to FileContent.tsx with the dispatch that reads it. Re-exported so every
// existing `import { View } from './Editor'` still names the same type.
export type { View };

export type Notice =
  | { tone: 'ok'; text: string }
  | { tone: 'info'; text: string }
  | { tone: 'bad'; text: string }
  | { tone: 'auth' };

// ── the document ─────────────────────────────────────────────────────────────
//
// Everything that used to be a single `useState` in Files.tsx, per document.
// `state` is the read's lifecycle and nothing else reads it: 'new' is the
// signal to Files.tsx's loader effect that this document has never been fetched
// (or must be fetched again after git moved it on disk).
export type DocState = 'new' | 'loading' | 'ready' | 'error' | 'auth';

export interface Doc {
  /** Stable for the life of the tab. NOT root+path: two tabs on one file are
   *  legal, and the draft they share is keyed by root+path in localStorage
   *  precisely because the FILE is the thing with one draft, not the tab. */
  id: string;
  root: string;
  path: string;
  state: DocState;
  file: FileRead | null;
  err: string | null;
  editing: boolean;
  draft: string;
  view: View;
  /** The commit message the inspector edits, per document. */
  message: string;
  notice: Notice | null;
  conflict: WriteConflict | null;
  saving: boolean;
  /** Where to jump once the content has loaded, set when the tab was opened from
   *  a search result: the 1-based line, and the run to SELECT within it so the
   *  editor lights up every other occurrence in the file.
   *
   *  A REQUEST, not a position: it is cleared the moment it is honoured, because
   *  a sticky value would drag the caret back every time the document
   *  re-rendered - and the caret is the user's, not ours. */
  goto?: { line: number; col: number; len: number } | null;
}

/** One column of the centre. Two at most - a third is a tiling window manager,
 *  not an editor, and every one of them is unreadable at this width. */
export interface Group {
  tabs: string[];
  active: string | null;
}

export function isDirty(d: Doc | null | undefined): boolean {
  return !!d && d.editing && !!d.file && d.draft !== d.file.content;
}

export function docKind(d: Doc): Kind {
  // `binary` is the backend's answer when it sends one; the local sniff is the
  // fallback for a response that does not carry the field.
  const binary = !!d.file && (d.file.binary === true || looksBinary(d.file.content ?? ''));
  return kindOf(d.path || (d.file?.path ?? ''), binary);
}

export function docLang(d: Doc): string {
  return d.file ? langFor(d.file.path, d.file.lang) : '';
}

export function isEditable(d: Doc | null): boolean {
  return !!d && !!d.file && d.file.writable && docKind(d) === 'text';
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
function NothingOpen() {
  return (
    <div className="fx-pad fx-empty">
      <span className="fx-empty-mark dim" aria-hidden="true"><BothyMark size={72} /></span>
      <div className="fx-empty-keys">
        {STARTER_KEYS.map((b) => (
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
// The read-only half of the pair, `Source`, moved to FileContent.tsx: it is a
// renderer with no draft in it, and a reader that never mounts CodeMirror needs
// exactly that and nothing else here.

// The textarea keeps its gutter in sync by hand, because a textarea's scroll
// position is not observable through React state at 60fps - and putting it in
// state would re-render the whole centre on every wheel notch.
function EditSurface({ draft, setDraft, handleRef, id }: {
  draft: string;
  setDraft: (v: string) => void;
  handleRef: React.RefObject<CodeHandle | null>;
  id: string;
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
  // `goto` returns FALSE for the same reason and one step further: a textarea has
  // no line addressing, and a caller told "done" would leave a search result
  // pointing at line 412 of a file scrolled to the top.
  useEffect(() => {
    handleRef.current = {
      focus: () => taRef.current?.focus(),
      openFind: () => {},
      goto: () => false,
    };
    return () => { handleRef.current = null; };
  }, [handleRef]);

  return (
    <div className="fx-code fx-code-edit">
      {gutter && <pre className="fx-gutter" ref={gutterRef} aria-hidden="true">{gutter}</pre>}
      {/* The id has to be unique per document now that every open document is
          mounted at once - a duplicated `for`/`id` pair points every label at
          whichever textarea the DOM found first. */}
      <label className="sr-only" htmlFor={`files-editor-${id}`}>File contents</label>
      <textarea
        id={`files-editor-${id}`}
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
  src: string; lang: string; editing: boolean; id: string;
  draft: string; setDraft: (v: string) => void;
  handleRef: React.RefObject<CodeHandle | null>;
}) {
  return p.editing
    ? <EditSurface draft={p.draft} setDraft={p.setDraft} handleRef={p.handleRef} id={p.id} />
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

/** True when THIS document's code surface is on screen. Three things in the
 *  status strip are facts about that surface - the cursor readout, the Find
 *  button and the Keys sheet - and none of them may outlive it.
 *
 *  This mirrors FileContent's dispatch and has to move with it: the surface is
 *  on screen exactly when that component falls through to `source`. Written
 *  once, beside its use, rather than re-derived at each one. */
function codeIsMounted(d: Doc | null, plain: boolean, diff: boolean): boolean {
  if (diff || !d || d.state !== 'ready' || !d.file || plain) return false;
  const lang = docLang(d);
  if (docKind(d) !== 'text') return false;
  return d.editing || !(d.view === 'preview' && (lang === 'md' || lang === 'json'));
}

// ── one document's surface ───────────────────────────────────────────────────
//
// What is left of it once the "which renderer" question moved to FileContent:
// the READ's lifecycle (loading, denied, failed), the EDIT surface, and the
// decision between them. Everything below the auth/error guards is the editable
// path; the read side is one component call.
//
// Deliberately hook-free, so the early returns below are legal and so a document
// that is merely hidden costs nothing to keep rendered.
function DocBody({
  doc, plain, onFail, onRetryOpen, setDraft, onStat, onDownload, canDownload, onFallback,
  editorRef, onOpenPath,
}: {
  doc: Doc;
  plain: boolean;
  onFail: () => void;
  onRetryOpen: () => void;
  setDraft: (v: string) => void;
  onStat: (s: CodeStat) => void;
  onDownload: () => void;
  canDownload: boolean;
  onFallback: (why: string) => void;
  editorRef: React.RefObject<CodeHandle | null>;
  /** Follow a repo-relative link out of a rendered document, into a tab. */
  onOpenPath: (root: string, path: string) => void;
}) {
  const { root, path, file, editing, draft, view } = doc;
  const kind = docKind(doc);
  const lang = docLang(doc);

  if (doc.state === 'auth') {
    return <div className="fx-pad"><SignInCard what="read this file" onRetry={onRetryOpen} /></div>;
  }
  if (doc.state !== 'ready' && doc.state !== 'error') {
    return <div className="fx-pad"><Skeleton variant="table" /></div>;
  }
  if (doc.state === 'error' || !file) {
    return (
      <div className="fx-pad">
        <ErrState
          title="Could not open that file"
          body={`${root}/${path} - ${doc.err ?? 'no content came back'}`}
          onRetry={onRetryOpen}
        />
      </div>
    );
  }

  const fallback = (
    <PlainSurface
      src={file.content} lang={lang} editing={editing} id={doc.id}
      draft={draft} setDraft={setDraft} handleRef={editorRef}
    />
  );

  // ONE surface for Source and Edit. A read-only file is this same editor with
  // `EditorState.readOnly` set - it reports `aria-readonly`, refuses every
  // write, and keeps the caret, the search panel and the line highlights that
  // a `<pre>` cannot have.
  //
  // NO `key` any more, and that is the point of the whole document model. It
  // used to be `key={root|path}`, which threw the EditorState away - and with
  // it the undo history - every time the open file changed. The document now
  // outlives the switch, so the history does too.
  const surface = plain ? fallback : (
    <CodeBoundary fallback={fallback} onFail={onFail}>
      <Suspense fallback={fallback}>
        <CodeSurface
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

  // EDITING short-circuits the whole dispatch, and always did: once you are
  // typing, the only honest view of the bytes is the one you are typing into,
  // whatever the file's kind says it could be rendered as.
  if (editing) return surface;

  return (
    <FileContent
      root={root}
      // The READ's path, not the tab's. They are the same today; if they ever
      // diverge, the name and the raw bytes must both come from the response.
      path={file.path}
      content={file.content}
      size={file.size}
      lang={lang}
      kind={kind}
      view={view}
      source={surface}
      onDownload={onDownload}
      canDownload={canDownload}
      onFallback={onFallback}
      // Relative links resolve against the DOCUMENT's directory and open in this
      // page's own root. The `#fragment` is dropped: this is the editor, where a
      // document arrives at the top and a scroll would fight the caret - the
      // reader is the surface that honours it.
      links={{ dir: dirName(path), open: (p) => onOpenPath(root, p), src: (p) => rawUrl(root, p) }}
    />
  );
}

// ── the tab strip ────────────────────────────────────────────────────────────
//
// `.fx-tabbar` finally holds tabs. It used to hold a breadcrumb, which is where
// the file's path now lives instead - down in the status strip, beside the rest
// of the facts about it, because a tab strip that also spells out a full path
// has no room left for the second tab.
function TabStrip({
  docs, activeId, dragId, onSelect, onClose, onDragStart, onDragEnd,
}: {
  docs: Doc[];
  activeId: string | null;
  dragId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
}) {
  const strip = useRef<HTMLDivElement | null>(null);

  // Overflow SCROLLS, it does not wrap: a wrapped strip changes the height of
  // the chrome as you open files, so the document under it jumps. Which means
  // the active tab can be off-screen, and the one moment that matters is the
  // moment it becomes active.
  useEffect(() => {
    if (!activeId) return;
    const el = strip.current?.querySelector(`[data-tab="${CSS.escape(activeId)}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  return (
    <div className="fx-tabs" role="tablist" aria-label="Open files" ref={strip}>
      {docs.map((d) => {
        const on = d.id === activeId;
        const name = baseName(d.path);
        return (
          // A div rather than a <button>: the close X is a button and buttons
          // do not nest. `role="tab"` plus a roving tabindex is what keeps it a
          // real control - it is focusable, Enter/Space activate it, and the
          // selected one is announced.
          <div
            key={d.id}
            data-tab={d.id}
            role="tab"
            tabIndex={on ? 0 : -1}
            aria-selected={on}
            className={`fx-tab${on ? ' on' : ''}${dragId === d.id ? ' dragging' : ''}`}
            title={`${d.root}/${d.path}`}
            draggable
            onDragStart={(e) => {
              // A payload is set as well as the ref, because a drag with an
              // empty dataTransfer is cancelled outright by Firefox.
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', d.id);
              onDragStart(d.id);
            }}
            onDragEnd={onDragEnd}
            onClick={() => onSelect(d.id)}
            // Middle-click closes, which means suppressing the browser's
            // autoscroll on the way down - it fires on mousedown, not on click.
            onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              onClose(d.id);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(d.id); }
            }}
          >
            <span className="fx-tab-name">{name}</span>
            {/* The unsaved dot, exactly where VS Code puts it, because that is
                where people look for it. `role="img"` is what makes the name
                reachable - `aria-label` on a bare <span> is ignored outright. */}
            {isDirty(d) && (
              <span className="fx-dot" role="img" aria-label="unsaved changes" title="unsaved changes" />
            )}
            <button
              type="button"
              className="fx-tab-x"
              aria-label={`Close ${name}`}
              title={`Close ${name}`}
              onClick={(e) => { e.stopPropagation(); onClose(d.id); }}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function Editor({
  group, docs, activeId, focused, canSplit, dragId,
  onFocusGroup, onSelect, onCloseDoc, onDragStart, onDragEnd, onDropInto, onDropEdge, onSplitOff,
  setDraft, setView, onEdit, onCancel, onSave, onRetryOpen,
  dismissNotice, onResolveConflict, pending, resolvePending,
  diff, diffRes, diffLoading, diffErr, onDiffSide, onCloseDiff,
  onDownload, onArchive, onReveal, canDownload, onFallback, handleFor, onOpenPath,
}: {
  /** Which of the (at most two) groups this is. Only used for names. */
  group: number;
  docs: Doc[];
  activeId: string | null;
  focused: boolean;
  /** There is only one group, so a tab dropped on this group's edge would make
   *  a second one. False once the split exists - a third group is not offered. */
  canSplit: boolean;
  dragId: string | null;
  onFocusGroup: () => void;
  onSelect: (id: string) => void;
  onCloseDoc: (id: string) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  /** A tab was dropped anywhere in this group: move it here. */
  onDropInto: () => void;
  /** A tab was dropped on this group's trailing edge: split, and move it into
   *  the group that creates. */
  onDropEdge: () => void;
  /** The keyboard/pointer equivalent of the edge drop, for the active document.
   *  A feature that only exists as a drag is a feature half the people using
   *  this page cannot reach. */
  onSplitOff: () => void;
  setDraft: (id: string, v: string) => void;
  setView: (v: View) => void;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  onRetryOpen: (id: string) => void;
  dismissNotice: () => void;
  onResolveConflict: (choice: 'mine' | 'theirs' | 'dismiss') => void;
  /** The document whose CLOSE is waiting on an answer, when it lives in this
   *  group. Switching away from a dirty document is free now - that is the
   *  whole point of tabs - so the guard has moved onto the one action that
   *  actually throws work away. */
  pending: { id: string; name: string } | null;
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
  /** The raw bytes, as an attachment. Also the binary card's own button. */
  onDownload: () => void;
  onArchive: (format: 'zip' | 'tgz') => void;
  /** Open every folder above the active document and scroll to its row. */
  onReveal: () => void;
  canDownload: boolean;
  onFallback: (why: string) => void;
  /** One imperative handle PER DOCUMENT. A single shared ref broke the moment
   *  every document stayed mounted: each surface writes `handleRef.current` on
   *  mount, so the last one to mount owned Find and focus for all of them. */
  handleFor: (id: string) => React.RefObject<CodeHandle | null>;
  /** Open a root-relative path, for a rendered document's cross-links. The same
   *  action the explorer's rows use, which is what stops a followed link being a
   *  second, subtly different way to open a file. */
  onOpenPath: (root: string, path: string) => void;
}) {
  const [plain, setPlain] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const onFail = useCallback(() => setPlain(true), []);

  const active = docs.find((d) => d.id === activeId) ?? null;
  const lang = active ? docLang(active) : '';
  const kind = active ? docKind(active) : 'text';
  const isMarkdown = lang === 'md';
  const isJson = lang === 'json';
  const editing = !!active?.editing;
  const dirty = isDirty(active);
  const editable = isEditable(active);
  const file = active?.file ?? null;
  const notice = active?.notice ?? null;
  const conflict = active?.conflict ?? null;
  const saving = !!active?.saving;

  // ── the cursor readout, and who it belongs to ──────────────────────────────
  //
  // Stamped with the document it was measured on. It used to be a bare
  // `CodeStat`, set by the code surface and never cleared - so opening a .md
  // after a .ts left `Ln 42, Col 7` from the PREVIOUS file sitting in the
  // status strip. A stale measurement that looks live is the one kind of wrong
  // a status strip must not be. With every document mounted at once there are
  // now several surfaces reporting, so the stamp is the id rather than a path.
  const [stat, setStat] = useState<{ id: string; s: CodeStat } | null>(null);
  const onStat = useCallback((id: string, s: CodeStat) => setStat({ id, s }), []);

  // The status strip's two measurements, memoised for the same reason the gutter
  // is: `new Blob([draft]).size` copies the whole string, and doing that on every
  // keystroke of a 1 MB file (the service's read ceiling) is a megabyte of
  // allocation per character typed. TextEncoder's byte length is the same
  // answer without the Blob.
  const shown = editing ? (active?.draft ?? '') : (file?.content ?? '');
  const byteSize = useMemo(
    () => (editing ? new TextEncoder().encode(shown).length : (file?.size ?? 0)),
    [editing, shown, file],
  );
  const lineCount = useMemo(() => (shown ? countLines(shown) : 0), [shown]);
  // Only formats with a genuine rendered form get a switcher. A shell script has
  // no "preview", and a toggle that swaps highlighted text for the same text is
  // a control that does nothing.
  // SVG and HTML are text with a rendered form, exactly like markdown - so they
  // get the switcher too. Without it a framed preview is a one-way door: the
  // file opens rendered and there is no way back to the source you came to edit.
  const framedText = !!active && isFramedText(kind, active.path);
  const previewable = kind === 'image' || isMarkdown || isJson || framedText;
  const showSwitcher = !diff && !editing && !!file && previewable && kind !== 'image';

  const codeMounted = codeIsMounted(active, plain, !!diff);
  const liveStat = codeMounted && stat && stat.id === activeId ? stat.s : null;
  const activeRef = activeId ? handleFor(activeId) : null;

  // Dropping is allowed anywhere in a group EXCEPT back into the group the tab
  // is already in, where it would be a no-op that still looks like it did
  // something. The trailing-edge zone is a separate target rendered on top.
  const dragging = !!dragId;
  const takesDrop = dragging && !docs.some((d) => d.id === dragId);

  // ── the overflow menu ──────────────────────────────────────────────────────
  //
  // The strip keeps the three things you touch constantly - the view switcher,
  // Edit/Save, and Close - and everything else moves in here. The test is not
  // "does it fit" but "would I look for it here": a download belongs beside the
  // file's size and its history, and Find belongs with the other things you DO
  // to a file rather than in a strip of measurements.
  //
  // Find and Keys used to live in the STATUS strip, which is now facts only.
  // Both are still gated on the code surface being mounted - they were dead in
  // Preview, because `editorRef.current` is null with no surface under it - but
  // a disabled row that says why is a much better answer than a button that
  // silently does nothing, and it is what leaving them in the menu buys.
  //
  // The three downloads are deliberately DUPLICATED with the Inspector, which is
  // their proper home. The reason is reachability, not convenience: the
  // inspector rail collapses, and with it collapsed there would otherwise be no
  // way to get the bytes of the open file at all.
  const items: MenuItem[] = [];
  if (diff) {
    items.push(
      {
        id: 'diff-working', label: 'Diff: working tree, against the index',
        icon: <Pencil size={13} />, disabled: !diff.staged,
        note: !diff.staged ? 'already showing' : undefined,
        onPick: () => onDiffSide(false),
      },
      {
        id: 'diff-staged', label: 'Diff: staged, against HEAD',
        icon: <GitCommitVertical size={13} />, disabled: diff.staged,
        note: diff.staged ? 'already showing' : undefined,
        onPick: () => onDiffSide(true),
      },
      { id: 'diff-close', label: 'Close the diff', icon: <X size={13} />, onPick: onCloseDiff },
    );
  }
  items.push(
    {
      id: 'find', label: 'Find in this file', icon: <Search size={13} />,
      chord: chordOf('find'), group: !!diff,
      disabled: !codeMounted,
      note: 'the text surface is not on screen - switch to Source',
      onPick: () => activeRef?.current?.openFind(),
    },
    {
      id: 'keys', label: keysOpen ? 'Hide the keyboard shortcuts' : 'Keyboard shortcuts',
      icon: <Keyboard size={13} />,
      disabled: !codeMounted,
      note: 'the text surface is not on screen - switch to Source',
      onPick: () => setKeysOpen((v) => !v),
    },
    {
      id: 'reveal', label: 'Reveal in the explorer', icon: <Crosshair size={13} />, group: true,
      disabled: !active, note: 'nothing is open',
      onPick: onReveal,
    },
    {
      id: 'split',
      label: canSplit ? 'Open in a split beside' : 'Move to the other group',
      icon: <Columns2 size={13} />,
      disabled: !active || (canSplit && docs.length < 2),
      note: !active ? 'nothing is open' : 'the last tab in a group cannot split off itself',
      onPick: onSplitOff,
    },
    {
      id: 'raw', label: 'Download the raw file', icon: <Download size={13} />, group: true,
      disabled: !active?.file || !canDownload,
      note: !canDownload ? 'sign in first - the download origin has no sign-in page' : 'nothing is open',
      onPick: onDownload,
    },
    {
      id: 'zip', label: 'Download as .zip', icon: <FileArchive size={13} />,
      disabled: !active?.file || !canDownload,
      note: !canDownload ? 'sign in first - the download origin has no sign-in page' : 'nothing is open',
      onPick: () => onArchive('zip'),
    },
    {
      id: 'tgz', label: 'Download as .tar.gz', icon: <FileArchive size={13} />,
      disabled: !active?.file || !canDownload,
      note: !canDownload ? 'sign in first - the download origin has no sign-in page' : 'nothing is open',
      onPick: () => onArchive('tgz'),
    },
  );

  return (
    <section
      className={`fx-centre${group === 1 ? ' fx-centre-b' : ''}${focused ? ' is-focused' : ''}`}
      aria-label={group === 1 ? 'File, second group' : 'File'}
      // Which group the keyboard and the inspector are talking about. Capture,
      // because the focus lands on a descendant and this is the only ancestor
      // that cares.
      onFocusCapture={onFocusGroup}
      onMouseDownCapture={onFocusGroup}
      onDragOver={takesDrop ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } : undefined}
      onDrop={takesDrop ? (e) => { e.preventDefault(); onDropInto(); } : undefined}
    >
      <header className="fx-tabbar">
        <TabStrip
          docs={docs}
          activeId={activeId}
          dragId={dragId}
          onSelect={onSelect}
          onClose={onCloseDoc}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />

        {/* ── the actions, as icons ───────────────────────────────────────────
            Every control here is a glyph plus a Tooltip plus an `aria-label`,
            which is the pattern the explorer header and the layout toggles
            already use - the strip is chrome, and chrome that spells itself out
            in words is chrome that keeps taking width from the file.

            The tooltip opens DOWNWARD (components/Tooltip.tsx: no portal, no
            collision logic) which is fine here - this strip is at the TOP. The
            same treatment is refused in the status strip at the bottom, where
            the bubble would open off-screen. */}
        <div className="fx-actions">
          {showSwitcher && (
            <div className="seg-toggle fx-seg fx-seg-ico" role="group" aria-label="View">
              <Tooltip label={isMarkdown ? 'Preview - rendered markdown'
                : framedText ? 'Preview - rendered document'
                : 'Preview - folded JSON'}>
                <button
                  type="button"
                  className={active?.view === 'preview' ? 'on' : ''}
                  aria-pressed={active?.view === 'preview'}
                  aria-label="Preview"
                  onClick={() => setView('preview')}
                >
                  <Eye size={13} aria-hidden="true" />
                </button>
              </Tooltip>
              <Tooltip label="Source - the text itself">
                <button
                  type="button"
                  className={active?.view === 'source' ? 'on' : ''}
                  aria-pressed={active?.view === 'source'}
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
            <Tooltip label="Edit this file">
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
              <Tooltip label={saving ? 'Saving…' : `Save to disk (${chordOf('save')})`}>
                <button type="button" className="fx-hbtn is-primary" onClick={onSave}
                        disabled={saving} aria-label={saving ? 'Saving' : 'Save to disk'}>
                  {saving
                    ? <LoaderCircle size={14} className="spin" aria-hidden="true" />
                    : <Save size={14} aria-hidden="true" />}
                </button>
              </Tooltip>
            </>
          )}
          {/* Everything else. Between Edit/Save and Close, so the two ends of
              the row stay where the hand expects them. */}
          <OverflowMenu items={items} />
          {/* Close sits LAST, at the far edge of the strip, away from the
              controls that change what you are looking at. Its neighbours are
              Edit and Save - one mis-click from "save" to "close" is the worst
              adjacency on this bar, so it gets a separator and the end of the
              row rather than a slot in the middle.

              It closes the ACTIVE TAB and goes through the same guard the tab's
              own X does, so closing with unsaved edits raises the banner rather
              than quietly discarding them. */}
          {active && (
            <Tooltip label={`Close ${baseName(active.path)}`} align="end">
              <button
                type="button"
                className="fx-hbtn fx-crumb-x"
                onClick={() => onCloseDoc(active.id)}
                aria-label={`Close ${baseName(active.path)}`}
              >
                <X size={14} />
              </button>
            </Tooltip>
          )}
        </div>
      </header>

      {pending && (
        <div className="fx-note warn" role="alert">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>
            <b>{pending.name}</b> has unsaved changes. Closing it discards them.
          </span>
          <span className="fx-note-actions">
            <button type="button" className="btn ghost sm" onClick={() => resolvePending(false)}>Keep editing</button>
            <button type="button" className="btn sm" onClick={() => resolvePending(true)}>Discard and close</button>
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

      {/* ── the stack ─────────────────────────────────────────────────────────
          Every open document, all the time. `hidden` on the inactive ones, which
          the CSS has to honour explicitly because they are flex containers and
          `display: flex` beats the UA's `display: none` for [hidden].

          This is what makes undo survive a tab switch. Rendering only the active
          document would put the surfaces back on a mount/unmount cycle, which is
          exactly the `key={docKey}` behaviour the document model replaced. */}
      <div className="fx-body">
        {docs.length === 0 && !diff && <NothingOpen />}
        {docs.map((d) => (
          <div className="fx-doc" key={d.id} hidden={d.id !== activeId || !!diff}>
            <DocBody
              doc={d}
              plain={plain}
              onFail={onFail}
              onRetryOpen={() => onRetryOpen(d.id)}
              setDraft={(v) => setDraft(d.id, v)}
              onStat={(s) => onStat(d.id, s)}
              onDownload={onDownload}
              canDownload={canDownload}
              onFallback={onFallback}
              editorRef={handleFor(d.id)}
              onOpenPath={onOpenPath}
            />
          </div>
        ))}
        {/* The diff sits OVER the stack rather than instead of it: it was asked
            for explicitly, the edit underneath is untouched, and closing it puts
            you back exactly where you were - undo history included. */}
        {diff && <DiffView target={diff} res={diffRes} loading={diffLoading} err={diffErr} />}

        {/* The edge target, only while a tab is actually in the air. A permanent
            drop zone on the side of the editor is a 40px strip of nothing for
            the 99% of the time nobody is dragging. */}
        {dragging && canSplit && (
          <div
            className="fx-dropedge"
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDropEdge(); }}
          >
            <span className="fx-dropedge-hint">Split</span>
          </div>
        )}
      </div>

      {/* The hotkeys, written down. An editor whose features are only reachable
          by knowing they exist has not shipped them - and the two that are least
          guessable (Alt-click for a second caret, Alt-Shift-drag for a column)
          are exactly the two nothing else on the page hints at. */}
      {keysOpen && codeMounted && (
        <div className="fx-keys" role="group" aria-label="Editor keys" id={`fx-keys-sheet-${group}`}>
          {EDITOR_KEYS.map((b) => (
            <span className="fx-key" key={b.id}>
              <Chord keys={b.keys} />
              <span className="fx-key-what">{b.what}</span>
            </span>
          ))}
        </div>
      )}

      {/* The status strip. Everything that used to be a tag scattered through
          the header, in the one place an editor puts it - plus the file's PATH,
          which moved down here when the header became a tab strip. A tab can
          only carry a name; the strip is where the rest of the identity goes. */}
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
        ) : active && file ? (
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
            <span className="fx-stat fx-path" title={`${active.root}/${active.path}`}>
              {active.root}/{dirName(active.path)}<b>{baseName(active.path)}</b>
            </span>
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
            {/* NO BUTTONS BELOW THIS LINE. Find and Keys used to sit here and
                have moved into the toolbar's overflow menu: this strip is a
                readout - position, size, language, whether the file can be
                written - and mixing two actions into a row of measurements made
                both harder to find. The one thing left is a reminder of a chord,
                which is a fact rather than a control. */}
            {editing && (
              <span className="fx-stat"><Chord keys={chordOf('save')} /> saves</span>
            )}
          </>
        ) : (
          <span className="fx-stat">{docs.length ? 'opening…' : 'no file open'}</span>
        )}
      </footer>
    </section>
  );
}

