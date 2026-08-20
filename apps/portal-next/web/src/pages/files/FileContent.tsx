// ── which renderer does this file get? ───────────────────────────────────────
//
// The DECISION, on its own, with nothing else attached. It was the tail of
// `DocBody` in Editor.tsx: a run of branches on `kind` and `view` - image, pdf,
// media, framed, binary, markdown preview, json preview, else the text surface.
// Forty lines, and the only reason rendering felt welded to the editor.
//
// The renderers themselves were already portable - md.tsx imports a language
// helper and the highlighter and nothing else, holds no state and makes no
// request. So this is an EXTRACTION OF THE DISPATCH, not a rewrite of the
// renderers, and the proof that it is right is that the editor still paints
// every kind exactly as it did.
//
// What this component is not allowed to grow, ever:
//
//   · a fetch          - the bytes arrive as a prop. `FileView` owns the read.
//   · a draft          - editing is a different concern with a different role.
//   · a role, a tab, a workspace, a URL.
//
// It is deliberately HOOK-FREE, like the function it came from, so the early
// returns below are legal and so an instance that is merely `hidden` (the editor
// keeps every open document mounted) costs nothing to keep rendered.
//
// The one thing it does NOT decide is what a plain text file looks like, because
// that is the one answer that depends on the caller: the editor hands in
// CodeMirror, which is also its edit surface, and a reader hands in a
// highlighted `<pre>`. So the text surface arrives as `source`, already built.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Download, FileDown } from 'lucide-react';
import { fmtBytes, rawUrl } from '../../lib/files';
import { countLines, gutterText, GUTTER_LIMIT, highlight } from './highlight';
import { renderMd, type MdLinks } from './md';
import { JsonView } from './JsonView';
import { baseName, type Kind } from './tree';

/** Rendered, or the text itself. Lives here rather than in Editor.tsx because it
 *  is a property of the CONTENT, and this is the module that acts on it -
 *  Editor.tsx re-exports it so every existing import still reads the same. */
export type View = 'preview' | 'source';

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
function RawPreview({ src, name, kind = 'image', onFallback }: {
  src: string; name: string; kind?: Kind; onFallback: (why: string) => void;
}) {
  // Only an IMAGE can be attempted as <img>. A PDF, a video or an HTML document
  // in an <img> is not a degraded render - it is a guaranteed onerror, which
  // would flash the "blocked" strip on every open and blame the sandbox for a
  // mismatch we chose. Those kinds start where they belong.
  const wantsFrame = kind !== 'image';
  const [mode, setMode] = useState<'img' | 'frame'>(wantsFrame ? 'frame' : 'img');
  // A new file is a new attempt - otherwise one blocked image would pin every
  // later one to the frame for the life of the page.
  useEffect(() => { setMode(wantsFrame ? 'frame' : 'img'); }, [src, wantsFrame]);

  if (mode === 'frame') {
    return (
      <div className="fx-media-wrap">
        {/* The degraded path is LABELLED. A frame shows the browser's own image
            viewer, which paints at natural size and crops rather than fitting -
            so without this strip the reader sees the top-left corner of their
            image and has no way to tell a rendering limitation from a broken
            file. Saying which of the two it is costs one line. */}
        {/* The note is about a DEGRADED image, so it only belongs to an image
            that fell back. For a PDF or a video the frame IS the viewer, and
            telling the reader something was refused would be a plain untruth. */}
        {!wantsFrame && (
          <p className="fx-media-note">
            Shown in a frame at natural size - click it to zoom. The sandbox origin
            is refusing to be embedded directly; the Inspector&apos;s <b>Raw</b> download
            is the full-size copy.
          </p>
        )}
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

function DownloadCard({ path, size, kind, onDownload, canDownload }: {
  path: string; size: number; kind: Kind; onDownload: () => void; canDownload: boolean;
}) {
  const isPdf = kind === 'pdf';
  return (
    <div className="fx-binary">
      <span className="fx-binary-ico"><FileDown size={22} aria-hidden="true" /></span>
      <h4>{isPdf ? 'PDF' : 'Binary file'}</h4>
      <p className="fx-binary-facts">
        <span className="mono">{baseName(path)}</span>
        <span aria-hidden="true">·</span>
        <span>{fmtBytes(size)}</span>
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

// ── the read-only text surface ───────────────────────────────────────────────
//
// A `<pre>` with a gutter. In the EDITOR this is only ever the fallback - the
// instant between the code-editor chunk being asked for and arriving, and the
// case where that chunk never arrives at all - but for a reader it is the whole
// answer, because a reader has no caret, no find panel and no line to highlight.
//
// Both the gutter and the highlight are memoised on the source string. Read-only
// that only matters once per file; in the editor it is the difference between
// typing being free and every keystroke rebuilding an array of N strings -
// 20,000 allocations per character on a large file.
export function Source({ src, lang }: { src: string; lang: string }) {
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

export function FileContent({
  root, path, content, size, lang, kind, view, source, onDownload, canDownload, onFallback, links,
  footer,
}: {
  /** The root key, for the sandbox-origin URL. Building a string is not I/O. */
  root: string;
  /** The file's own path, as the READ returned it - `baseName` and the raw URL
   *  are both taken from it, so a caller that passes the tree's path instead
   *  would label the document with a name the bytes may not have. */
  path: string;
  /** Decoded text. Empty for a kind that has none; nothing here reads it except
   *  the two rendered text views. */
  content: string;
  size: number;
  /** The SERVICE's language for the file where it sent one, the extension's
   *  otherwise - `langFor()`, which the caller has already run because it needs
   *  the same answer to build `source`. It decides which of the two rendered
   *  text views exists; deriving it from the extension here instead would
   *  disagree with the hint on exactly the files the hint was added for. */
  lang: string;
  kind: Kind;
  view: View;
  /** What a plain text file renders as, already built. See the note at the top:
   *  it is the one branch whose answer belongs to the caller. */
  source: ReactNode;
  onDownload: () => void;
  canDownload: boolean;
  onFallback: (why: string) => void;
  /** Where a repo-relative markdown link goes, when there is somewhere for it to
   *  go. Absent means the reader has no navigation to offer, and those links
   *  keep rendering as inert text - see md.tsx. */
  links?: MdLinks;
  /** Rendered as the last block INSIDE the rendered document, after the markdown.
   *
   *  It exists because "after the document" and "below the document" are not the
   *  same place and the difference is invisible until you scroll. `.fx-read` is
   *  the element with `overflow: auto`, so anything rendered as a SIBLING of it
   *  is laid out below the scroll container - permanently in view, docked to the
   *  bottom of the pane, taking height from every page. That is where the
   *  reader's backlinks panel was, and its own comment said it meant to be
   *  "AFTER the document". A prop is the smaller fix than moving the scroller,
   *  and it keeps Toc's `scrollerOf()` walk resolving to the same element.
   *
   *  Only the RENDERED MARKDOWN branch takes one, and that is honest rather than
   *  an omission: an image, a PDF and a download card are not documents, they
   *  have no end to be after, and there is no `.fx-read` to be inside. */
  footer?: ReactNode;
}) {
  if (kind === 'image') {
    return <RawPreview src={rawUrl(root, path)} name={baseName(path)} onFallback={onFallback} />;
  }
  // PDF, SVG, HTML and video all render in the sandbox frame. Each of these
  // used to fall through to a download card or to source, not because the
  // bytes were unavailable but because the client never asked for them -
  // /raw has served every one of these inline, on :8100, since the origin
  // split landed.
  if (kind === 'pdf' || kind === 'media' || (kind === 'framed' && view === 'preview')) {
    return <RawPreview src={rawUrl(root, path)} name={baseName(path)} kind={kind} onFallback={onFallback} />;
  }
  if (kind === 'binary') {
    return <DownloadCard path={path} size={size} kind={kind} onDownload={onDownload} canDownload={canDownload} />;
  }
  if (view === 'preview' && lang === 'md') {
    // `<article>` already carries a role, so it wants a NAME rather than a
    // second role - an unnamed tab stop is the defect, not the element.
    return (
      <article
        className="fx-read md scroll-shade"
        tabIndex={0}
        aria-label={`${baseName(path)} - rendered`}
      >
        {renderMd(content, 'b', links)}
        {footer}
      </article>
    );
  }
  if (view === 'preview' && lang === 'json') return <JsonView src={content} />;
  return <>{source}</>;
}
