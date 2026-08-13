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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, CircleCheck, Code2, Download, Eye, FileDown, Info, LoaderCircle,
  Lock, LogIn, Pencil, Save, Undo2, X,
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

// ── source, with a gutter ────────────────────────────────────────────────────
//
// Both the gutter and the highlight are memoised on the source string. In the
// read-only view that only matters once per file; in the EDITOR below it is the
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

// The editor keeps its gutter in sync by hand, because a textarea's scroll
// position is not observable through React state at 60fps - and putting it in
// state would re-render the whole centre on every wheel notch.
function EditSurface({ draft, setDraft, editorRef }: {
  draft: string;
  setDraft: (v: string) => void;
  editorRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const gutterRef = useRef<HTMLPreElement | null>(null);
  // Recomputed only when the LINE COUNT changes, not on every keystroke: typing
  // inside a line leaves the gutter identical, and that is the common case.
  const lines = useMemo(() => countLines(draft), [draft]);
  const gutter = useMemo(() => (lines <= GUTTER_LIMIT ? gutterText(lines) : null), [lines]);
  const sync = useCallback(() => {
    if (gutterRef.current && editorRef.current) gutterRef.current.scrollTop = editorRef.current.scrollTop;
  }, [editorRef]);

  return (
    <div className="fx-code fx-code-edit">
      {gutter && <pre className="fx-gutter" ref={gutterRef} aria-hidden="true">{gutter}</pre>}
      <label className="sr-only" htmlFor="files-editor">File contents</label>
      <textarea
        id="files-editor"
        ref={editorRef}
        className="fx-textarea"
        value={draft}
        spellCheck={false}
        onScroll={sync}
        onChange={(e) => setDraft(e.target.value)}
      />
    </div>
  );
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
  editorRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const isMarkdown = lang === 'md';
  const isJson = lang === 'json';

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
    if (editing) return <EditSurface draft={draft} setDraft={setDraft} editorRef={editorRef} />;
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
    return <Source src={file.content} lang={lang} />;
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

      <div className="fx-body">{body()}</div>

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
            {kind === 'text' && !editing && !willHighlight(file.content, lang) && lang && (
              <span className="fx-stat">highlighting off - too large</span>
            )}
            <span className="fx-status-spacer" />
            {editing && <span className="fx-stat"><span className="kbd">Ctrl</span> <span className="kbd">S</span> saves</span>}
          </>
        ) : (
          <span className="fx-stat">no file open</span>
        )}
      </footer>
    </section>
  );
}
