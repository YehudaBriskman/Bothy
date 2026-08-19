// ── one file, read ───────────────────────────────────────────────────────────
//
// `FileContent` plus the one fetch it does not do, and the four answers that
// fetch can give which are not bytes: still loading, not there, not yours, too
// big. That is the entire component.
//
// The line that keeps it that size, from docs/plans/reading-first.md §7:
// **reading mode never writes.** Not "does not write yet". There is no draft
// here, no dirty flag, no conflict check and no save, because the failure mode
// this boundary exists to prevent is a reader that grows a save button, then a
// dirty indicator, then a conflict dialog, until there are two editors and the
// second one is missing the check that makes the first one safe. A change that
// would give this a write path belongs in the editor, and the reader's answer is
// a link into it.
//
// A 401 is NOT an error. lib/files.ts models it as a first-class result for the
// whole file plane - every endpoint needs a session now that the roots include
// ~/projects - so a signed-out visitor gets the invitation the rest of the page
// gives them, not a red box.

import { useEffect, useRef, useState } from 'react';
import {
  ApiError, isAuthError, langFor, looksBinary, openDownload, rawUrl, readFile,
  type FileRead,
} from '../../lib/files';
import { ErrState, Skeleton } from '../../components/states';
import { FileContent, Source, type View } from './FileContent';
import { SignInCard } from './SignInCard';
import { dirName, kindOf } from './tree';

type State =
  | { at: 'loading' }
  | { at: 'ready'; file: FileRead }
  | { at: 'auth' }
  | { at: 'missing' }
  | { at: 'too-large'; why: string }
  | { at: 'error'; why: string };

export function FileView({
  root, path, view = 'preview', frag = '', onOpen, onLoad, resolveWiki,
}: {
  root: string;
  path: string;
  /** Controlled by the caller. A reader that wants a Preview/Source switch owns
   *  the switch; this component does not grow chrome of its own. */
  view?: View;
  /** The `#heading` to land on, if the caller arrived by following a link. */
  frag?: string;
  /** Resolve a `[[wikilink]]` against the documents that exist. Passed down
   *  rather than computed here for the reason md.tsx gives: answering one needs
   *  the list of files, and neither this component nor the renderer holds it. */
  resolveWiki?: (target: string) => { path: string; frag: string } | null;
  /** Follow a cross-document link. Absent means those links keep rendering as
   *  inert text, which is the honest state for a view with nowhere to send you. */
  onOpen?: (path: string, frag: string) => void;
  /** The file this view is currently showing, or null while it is not showing
   *  one. Read-only, and it is worth saying WHY that is not a crack in the rule
   *  at the top: a caller cannot write anything with it. It exists because the
   *  facts a reader puts around a document - when it last changed and who
   *  changed it - come back on the SAME read this component already made, and
   *  the alternative is the page fetching the file a second time to learn what
   *  this component already knows. */
  onLoad?: (file: FileRead | null) => void;
}) {
  const [state, setState] = useState<State>({ at: 'loading' });
  const [tick, setTick] = useState(0);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!root || !path) { setState({ at: 'missing' }); return; }
    const ac = new AbortController();
    setState({ at: 'loading' });
    readFile(root, path, ac.signal)
      .then((f) => { if (!ac.signal.aborted) setState({ at: 'ready', file: f }); })
      .catch((e: unknown) => {
        // An abort is this view superseding its own request - the ordinary cost
        // of clicking a second link before the first one landed.
        if (ac.signal.aborted) return;
        if (isAuthError(e)) { setState({ at: 'auth' }); return; }
        const status = e instanceof ApiError ? e.status : 0;
        const why = e instanceof Error ? e.message : String(e);
        if (status === 404) setState({ at: 'missing' });
        // 413 is the service's read ceiling, and it is a FACT about the file
        // rather than a failure of the page - so it says so, and offers the
        // bytes, which are still downloadable.
        else if (status === 413) setState({ at: 'too-large', why });
        else setState({ at: 'error', why });
      });
    return () => ac.abort();
  }, [root, path, tick]);

  // The `#heading` half of a followed link. Scoped to THIS view's own subtree
  // rather than looked up by id, because md.tsx writes the slug to a data
  // attribute - see the note there about several documents being mounted at once
  // in the editor.
  //
  // `auto` rather than `smooth`: the document has just appeared, so there is
  // nothing to animate from and a scroll animation from the top of a long file
  // is a second of nothing happening.
  useEffect(() => {
    if (state.at !== 'ready' || !frag) return;
    const slug = frag.replace(/^#/, '');
    if (!slug) return;
    const at = box.current?.querySelector(`[data-md-anchor="${CSS.escape(slug)}"]`);
    at?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }, [state, frag]);

  // Announced from an EFFECT rather than from the `.then()` above, so a caller
  // that sets state on it is not doing so during this component's render - and
  // so every path that stops showing a file (missing, denied, too large) reports
  // the same `null` without each catch branch having to remember to.
  const notify = useRef(onLoad);
  useEffect(() => { notify.current = onLoad; });
  useEffect(() => {
    notify.current?.(state.at === 'ready' ? state.file : null);
  }, [state]);

  const retry = () => setTick((n) => n + 1);

  if (state.at === 'loading') return <div className="fx-pad"><Skeleton variant="table" /></div>;
  if (state.at === 'auth') {
    return <div className="fx-pad"><SignInCard what="read this file" onRetry={retry} /></div>;
  }
  if (state.at === 'missing') {
    return (
      <div className="fx-pad">
        <ErrState
          title="No such file"
          body={`${root}/${path} is not in that root. It may have been moved or renamed since the link was written.`}
          onRetry={root && path ? retry : undefined}
        />
      </div>
    );
  }
  if (state.at === 'too-large') {
    return (
      <div className="fx-pad">
        <ErrState
          title="Too large to show"
          body={`${root}/${path} - ${state.why}. The bytes are still downloadable from the sandbox origin.`}
        />
      </div>
    );
  }
  if (state.at === 'error') {
    return (
      <div className="fx-pad">
        <ErrState title="Could not open that file" body={`${root}/${path} - ${state.why}`} onRetry={retry} />
      </div>
    );
  }

  const { file } = state;
  const lang = langFor(file.path, file.lang);
  // The backend's answer where it sends one; the local sniff is the fallback for
  // a response that does not carry the field. Same rule as the editor's.
  const binary = file.binary === true || looksBinary(file.content ?? '');
  const kind = kindOf(path || file.path, binary);
  const dir = dirName(file.path);

  return (
    <div className="fx-doc" ref={box}>
      <FileContent
        root={root}
        path={file.path}
        content={file.content}
        size={file.size}
        lang={lang}
        kind={kind}
        view={view}
        // The read-only surface, always. Reaching for CodeMirror here would pull
        // the editor's chunk into a page that has nothing to edit with it.
        source={<Source src={file.content} lang={lang} />}
        onDownload={() => openDownload(rawUrl(root, file.path, true))}
        // The read succeeded, so this session has `viewer` - which is the same
        // role the sandbox origin checks for the raw bytes.
        canDownload
        // Nothing on this surface reports a degraded image; the frame it falls
        // back to labels itself.
        onFallback={() => {}}
        links={onOpen ? { dir, open: onOpen, resolveWiki, src: (p) => rawUrl(root, p) } : undefined}
      />
    </div>
  );
}
