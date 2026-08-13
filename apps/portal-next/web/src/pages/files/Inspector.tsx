// ── the right rail ───────────────────────────────────────────────────────────
//
// Was a bare commit list. It answers four questions now, and they are stacked in
// the order someone actually asks them about a file they have just opened:
//
//   1. What IS this?      path, size, language, when it changed, whether it is
//                         in git, whether this session may write it, and the
//                         `sensitive` advisory when the service raised one.
//   2. Who changed it?    the history, with author, relative date and a sha you
//                         can copy - a sha you have to retype is a sha nobody
//                         uses.
//   3. How do I commit?   the commit-message form, moved here from under the
//                         textarea. It belongs beside the history it is about to
//                         add a row to, and moving it stopped the editor from
//                         losing 60px of height to a field that is only in use
//                         while saving.
//   4. How do I get it?   raw, zip, tar.gz.
//
// Downloads are GATED here rather than delegated to a redirect. The sandbox
// origin has no sign-in page - an unauthenticated request to it is a bare 401 -
// and this page already knows whether there is a session, because it loaded the
// tree. Letting a signed-out click through would open a tab showing the word
// "Unauthorized", which is a worse answer than the one we can give.

import { useCallback, useState } from 'react';
import {
  Check, Copy, Download, FileArchive, GitCommitVertical, Lock, ShieldAlert,
} from 'lucide-react';
import { fmtBytes, relDate, type Commit, type FileRead } from '../../lib/files';
import { Tooltip } from '../../components/Tooltip';
import { baseName } from './tree';

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="fx-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Sha({ sha }: { sha: string }) {
  const [done, setDone] = useState(false);
  const copy = useCallback(() => {
    // navigator.clipboard is undefined on a plain-HTTP origin that is not
    // localhost, and this box is reached over http on a tailnet IP - so the
    // execCommand path is not legacy cruft here, it is the one that runs.
    const write = navigator.clipboard?.writeText(sha)
      ?? new Promise<void>((res, rej) => {
        const ta = document.createElement('textarea');
        ta.value = sha;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        ok ? res() : rej(new Error('copy refused'));
      });
    write.then(() => {
      setDone(true);
      setTimeout(() => setDone(false), 1400);
    }).catch(() => { /* nothing useful to say; the sha is on screen to select */ });
  }, [sha]);

  return (
    <button type="button" className="fx-sha" onClick={copy} title={`Copy ${sha}`} aria-label={`Copy commit ${sha}`}>
      <span className="mono">{sha.slice(0, 7)}</span>
      {done ? <Check size={10} aria-hidden="true" /> : <Copy size={10} aria-hidden="true" />}
    </button>
  );
}

export function Inspector({
  root, path, file, loading, history, newSha, editing, message, setMessage,
  messagePlaceholder, canDownload, onDownload, onArchive,
}: {
  root: string;
  path: string;
  file: FileRead | null;
  loading: boolean;
  history: Commit[] | null;
  newSha: string | null;
  editing: boolean;
  message: string;
  setMessage: (v: string) => void;
  messagePlaceholder: string;
  canDownload: boolean;
  onDownload: (download: boolean) => void;
  onArchive: (format: 'zip' | 'tgz') => void;
}) {
  return (
    <aside className="fx-rail fx-rail-r" aria-label="Inspector">
      <div className="fx-rail-h">
        <span className="fx-rail-title">Inspector</span>
        {history && (
          <span className="fx-rail-sub tnum">{history.length} commit{history.length === 1 ? '' : 's'}</span>
        )}
      </div>

      <div className="fx-insp scroll-shade">
        {!path ? (
          <p className="fx-insp-empty">Open a file to see what it is and how it got here.</p>
        ) : (
          <>
            {file && (
              <>
                {/* The advisory, first and loud. It never refuses the file -
                    the service decided that deliberately - but a reader who has
                    just opened something that looks like a credential should
                    find that out at the top of the rail, not in a tooltip. */}
                {file.sensitive && (
                  <div className="fx-sensitive" role="note">
                    <ShieldAlert size={15} aria-hidden="true" />
                    <span><b>Looks sensitive.</b> {file.sensitive}</span>
                  </div>
                )}

                <section className="fx-insp-sec">
                  <h3 className="fx-insp-h">File</h3>
                  <dl className="fx-facts">
                    <Fact label="Path"><span className="mono fx-fact-path">{root}/{file.path}</span></Fact>
                    <Fact label="Size"><span className="tnum">{fmtBytes(file.size)}</span></Fact>
                    {file.lang && <Fact label="Language"><span className="mono">{file.lang}</span></Fact>}
                    <Fact label="Modified">
                      <Tooltip label={new Date(file.mtime * 1000).toLocaleString()}>
                        <span>{relDate(new Date(file.mtime * 1000).toISOString())}</span>
                      </Tooltip>
                    </Fact>
                    <Fact label="Versioned">
                      {file.versioned === false
                        ? <span className="tag">not in git</span>
                        : <span className="tag public">git</span>}
                    </Fact>
                    <Fact label="Writable">
                      {file.writable
                        ? <span className="tag public">yes</span>
                        : <span className="tag"><Lock size={9} aria-hidden="true" /> no</span>}
                    </Fact>
                  </dl>
                </section>

                <section className="fx-insp-sec">
                  <h3 className="fx-insp-h">Download</h3>
                  <div className="fx-dl">
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={!canDownload}
                      onClick={() => onDownload(true)}
                      title={`${baseName(file.path)} - the file itself`}
                    >
                      <Download size={13} aria-hidden="true" /> Raw
                    </button>
                    <button type="button" className="btn ghost sm" disabled={!canDownload} onClick={() => onArchive('zip')}>
                      <FileArchive size={13} aria-hidden="true" /> .zip
                    </button>
                    <button type="button" className="btn ghost sm" disabled={!canDownload} onClick={() => onArchive('tgz')}>
                      <FileArchive size={13} aria-hidden="true" /> .tar.gz
                    </button>
                  </div>
                  <p className="fx-dl-note">
                    {canDownload
                      ? <>Served from the sandbox origin on port <span className="mono">8100</span>, so nothing it returns can touch this page.</>
                      : <>Sign in first - the download origin has no sign-in page of its own.</>}
                  </p>
                </section>
              </>
            )}

            {editing && (
              <section className="fx-insp-sec">
                <h3 className="fx-insp-h">Commit</h3>
                <label className="fx-commit-msg">
                  <span className="sr-only">Commit message</span>
                  <input
                    type="text"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder={messagePlaceholder}
                  />
                </label>
                <p className="fx-dl-note">
                  Saving writes the file and commits it as you. <span className="kbd">Ctrl</span> <span className="kbd">S</span>.
                </p>
              </section>
            )}

            <section className="fx-insp-sec">
              <h3 className="fx-insp-h">History</h3>
              {loading ? (
                <div className="fx-skel" aria-hidden="true">
                  {Array.from({ length: 4 }, (_, i) => <span className="skel" key={i} />)}
                </div>
              ) : !history ? (
                <p className="fx-insp-empty">No history yet.</p>
              ) : !history.length ? (
                <p className="fx-insp-empty">No commits touch this path - it is untracked, or outside a repo.</p>
              ) : (
                <ol className="fx-commits">
                  {history.map((c) => (
                    <li
                      className={`fx-commit ${c.sha === newSha ? 'is-new' : ''}`}
                      key={c.sha}
                      title={new Date(c.date).toLocaleString()}
                    >
                      <GitCommitVertical size={14} className="fx-commit-ico" aria-hidden="true" />
                      <div className="fx-commit-body">
                        <div className="fx-commit-subject">{c.subject}</div>
                        <div className="fx-commit-meta">
                          <Sha sha={c.sha} />
                          <span className="fx-commit-author">{c.author}</span>
                          <span className="fx-commit-when tnum">{relDate(c.date)}</span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
