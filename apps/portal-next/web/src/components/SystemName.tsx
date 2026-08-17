// Renaming a system, from the page the name is on.
//
// This is the whole of docs/plans/editing-model.md §9 in one panel: find the
// file, show what is patchable, carry the conflict check, and then - the part
// that matters - say honestly that the write landed in a file and has not
// reached the container.
//
// ── the pending state is the feature ────────────────────────────────────────
//
// A compose label is read when a container is CREATED. Save a new name and the
// file changes, the request returns 200, and the heading two panels above still
// says the old name, because that heading is drawn from what docker reports
// about a container that already exists. Every instinct says to paper over this
// - patch the title locally, show the new name, call it done - and that is
// precisely the lie the plan refuses: "One place, with an honest pending state,
// beats two places that agree most of the time."
//
// So nothing here ever renders the typed value as though it were live. The
// panel compares the file's value against the container's label and, when they
// differ, says so in the collector's own vocabulary - declared versus observed -
// and names the thing that would close the gap. That comparison is a derivation
// (lib/config.ts::driftOf), not a flag set after a save, which is why it is also
// correct for a file somebody changed in `vim` and why it clears itself the
// moment the container is replaced rather than when this tab decides it has.
//
// ── and Apply does not lie either ───────────────────────────────────────────
//
// The action tier has three verbs and `recreate` is deliberately not one of
// them: the write socket proxy is configured so that /containers/create cannot
// be reached at all. `docker restart` keeps the container it has, so it does not
// re-read the file and does not move a label. The panel therefore offers the
// recreate COMMAND as the thing that applies this, and offers Restart beside it
// with its limitation stated before the click rather than discovered after it.
// A button labelled "Apply" that did not apply would be worse than no button.
//
// WHAT THE INTERFACE HIDES IS NEVER WHAT THE API ENFORCES. `canEdit` decides
// whether the input is live. Every /-/api/config/patch call is gated at the edge
// by a forwardAuth middleware reading a signed cookie, which would refuse a
// hand-written curl identically. This is a courtesy that turns a bare 403 into a
// sentence arriving before the work rather than after it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, Copy, FileText, LogIn, RotateCw } from 'lucide-react';
import {
  APPLY, PROJECT_TITLE_FIELD, composeTarget, driftOf, loadFields, patchField,
  recreateCommand, refusalOf, whyNoFile, whyRefused,
  type ComposeTarget, type Drift, type FieldsResult, type PatchResult, type Refusal,
} from '../lib/config';
import { act, refusalOf as actionRefusalOf, type ActionResult, type Refusal as ActionRefusal } from '../lib/actions';
import { useOperator } from '../lib/session';
import { usePortal } from '../lib/data';
import { hasRole, signInHref } from '../lib/me';
import type { PortalNode } from '../lib/discover';
import './SystemName.css';

// Loading the file, and the four things that can come back.
type Load =
  | { t: 'loading' }
  | { t: 'ready'; fields: FieldsResult }
  | { t: 'failed'; refusal: Refusal };

// Saving. One union rather than three booleans, because "saving" and "saved"
// being true at once is how a form comes to show two answers.
type Save =
  | { t: 'rest' }
  | { t: 'saving' }
  | { t: 'saved'; res: PatchResult }
  | { t: 'failed'; refusal: Refusal };

// The restart, which is a different tier with a different role and its own
// refusal vocabulary - so it gets its own state rather than being folded in.
type Apply =
  | { t: 'rest' }
  | { t: 'working' }
  | { t: 'done'; res: ActionResult }
  | { t: 'failed'; refusal: ActionRefusal };

export function SystemName({
  nodes, onDrift,
}: {
  nodes: PortalNode[];
  /** Reported UP, so the page heading - which is the thing showing the stale
   *  name - can carry one line about it without a second fetch. The comparison
   *  still happens in exactly one place; this only tells the parent its answer. */
  onDrift?: (drift: Drift | null) => void;
}) {
  const { me, loading: sessionLoading, canAct } = useOperator();
  const { refresh } = usePortal();

  // Every container in the system, reduced to the two things the derivation
  // needs. Recomputed when the poll lands, which is what makes the observed side
  // of the drift comparison current rather than a snapshot of page load.
  const target = useMemo<ComposeTarget>(
    () => composeTarget(
      nodes
        .filter((n) => n.container)
        .map((n) => ({ container: n.container!.name, labels: n.container!.labels ?? {} })),
      PROJECT_TITLE_FIELD,
    ),
    [nodes],
  );

  const file = target.t === 'file' ? target : null;
  const noFile = whyNoFile(target);

  const [load, setLoad] = useState<Load>({ t: 'loading' });
  const [save, setSave] = useState<Save>({ t: 'rest' });
  const [apply, setApply] = useState<Apply>({ t: 'rest' });
  const [draft, setDraft] = useState('');
  // True once the reader has typed, so the draft stops being re-seeded from the
  // file underneath them. Without it, a reload after a conflict - or the poll
  // landing at the wrong moment - would silently replace what they wrote.
  const touched = useRef(false);
  const [copied, setCopied] = useState(false);

  const root = file?.root;
  const path = file?.path;

  const read = useCallback((signal?: AbortSignal) => {
    if (!root || !path) return;
    setLoad({ t: 'loading' });
    loadFields(root, path, signal)
      .then((fields) => {
        if (signal?.aborted) return;
        setLoad({ t: 'ready', fields });
        const site = fields.fields.find((f) => f.field === PROJECT_TITLE_FIELD);
        if (site && !touched.current) setDraft(site.value);
      })
      .catch((e) => {
        if (signal?.aborted) return;
        setLoad({ t: 'failed', refusal: refusalOf(e, 'read') });
      });
  }, [root, path]);

  useEffect(() => {
    if (!root || !path) return;
    const ac = new AbortController();
    read(ac.signal);
    return () => ac.abort();
  }, [root, path, read]);

  const site = load.t === 'ready'
    ? load.fields.fields.find((f) => f.field === PROJECT_TITLE_FIELD) ?? null
    : null;

  // THE COMPARISON. Declared is what the file says; observed is the label the
  // running container carries. Nothing here is remembered from a previous save.
  const drift = driftOf(site?.value, file?.observed);

  useEffect(() => { onDrift?.(drift); }, [onDrift, drift?.declared, drift?.observed]); // eslint-disable-line react-hooks/exhaustive-deps

  // In DEV the session is always signed out - `vite dev` proxies /oauth2/* at a
  // box this browser holds no cookie for - so the same localStorage override
  // lib/session.ts applies to `operator` is read here for `editor`. It changes
  // what is DRAWN and nothing else, which is the same sentence that is true of
  // the role layer in production. Widening useOperator() itself would change a
  // module ServiceActions.tsx depends on, for a dev-only affordance.
  let canEdit = hasRole(me, 'editor');
  if (import.meta.env.DEV) {
    let raw: string | null = null;
    try { raw = localStorage.getItem('bothy-dev-roles'); } catch { raw = null; }
    if (raw !== null) canEdit = raw.split(',').some((r) => r.trim() === 'editor');
  }

  const localRefusal = site ? whyRefused(draft, site.maxLength) : null;
  const unchanged = !!site && draft === site.value;
  const canSave = !!site && canEdit && !unchanged && !localRefusal && save.t !== 'saving';

  const onSave = useCallback(async () => {
    if (!file || !site || load.t !== 'ready') return;
    setSave({ t: 'saving' });
    try {
      const res = await patchField({
        root: file.root,
        path: file.path,
        field: PROJECT_TITLE_FIELD,
        value: draft,
        // THE CONFLICT CHECK, carried from the GET that filled this form in. The
        // service requires it and the reason it does is this form: one value is
        // sent for a file nobody was shown, so a patch with no baseMtime is a
        // patch against a version nobody can name.
        baseMtime: load.fields.mtime,
        // Named rather than inferred, so a file declaring the label on two
        // services is never resolved by guessing which one was meant.
        service: site.service,
      });
      setSave({ t: 'saved', res });
      // The authoritative mtime and value, from the response rather than from a
      // second GET - one write, one answer. The next save's conflict check is
      // against this, so a second edit in the same sitting does not 409 against
      // the mtime this form loaded with.
      setLoad({
        t: 'ready',
        fields: {
          ...load.fields,
          mtime: res.mtime,
          fields: load.fields.fields.map((f) =>
            f.field === PROJECT_TITLE_FIELD ? { ...f, value: res.value } : f),
        },
      });
      touched.current = false;
      // Re-read what is RUNNING, so the drift comparison is against a fresh
      // observation rather than one up to ten seconds old. It will still differ -
      // that is the point - but it should differ because of the file, not
      // because the poll is stale.
      refresh();
    } catch (e) {
      setSave({ t: 'failed', refusal: refusalOf(e, 'write') });
    }
  }, [file, site, load, draft, refresh]);

  const onRestart = useCallback(async () => {
    if (!file) return;
    setApply({ t: 'working' });
    try {
      const res = await act(file.container, 'restart');
      setApply({ t: 'done', res });
      refresh();
    } catch (e) {
      setApply({ t: 'failed', refusal: actionRefusalOf(e, 'restart', file.container) });
    }
  }, [file, refresh]);

  const onCopy = useCallback(() => {
    if (!file) return;
    void navigator.clipboard?.writeText(recreateCommand(file)).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 2200); },
      () => { /* A clipboard the browser refused is not worth a message: the
                 command is on screen and selectable. */ },
    );
  }, [file]);

  // ── nothing to edit ───────────────────────────────────────────────────────
  if (noFile) {
    return (
      <div className="sn">
        <p className="sn-h">{noFile.title}</p>
        <p className="sn-note">{noFile.detail}</p>
      </div>
    );
  }
  if (!file) return null; // unreachable - whyNoFile covers every other case

  const filePath = `${file.root} / ${file.path}`;
  const filesHref = `/files?root=${encodeURIComponent(file.root)}&path=${encodeURIComponent(file.path)}`;

  return (
    <div className="sn">
      {load.t === 'loading' && (
        <p className="sn-note" role="status">Reading {filePath}…</p>
      )}

      {load.t === 'failed' && (
        <RefusalBlock refusal={load.refusal} signedIn={!!me} />
      )}

      {load.t === 'ready' && !site && (
        <>
          <p className="sn-h">This system has no declared name.</p>
          <p className="sn-note">
            <span className="mono">{file.path}</span> carries no{' '}
            <span className="mono">{PROJECT_TITLE_FIELD}</span> label, so there is nothing for a form
            to change. Bothy is titling this system from its compose project name instead. Adding the
            label is a text edit rather than a form field - a form exists only where Bothy can
            validate the value, and it cannot validate a line that is not there yet.
          </p>
          <p className="sn-note">
            <Link className="link" to={filesHref}>Open {file.path} in Bothy Files</Link>
          </p>
        </>
      )}

      {load.t === 'ready' && site && (
        <>
          {/* ── the pending state ──────────────────────────────────────────
              First, above the form, because it is a fact about the box that is
              true whether or not this tab did anything - and because the reader
              arriving after a save needs it before they need the input again. */}
          {drift && (
            <section className="sn-drift" aria-labelledby="sn-drift-h">
              <p className="sn-drift-h" id="sn-drift-h">
                <AlertTriangle size={16} aria-hidden="true" />
                {APPLY.title}
              </p>
              <dl className="sn-vs">
                <div>
                  <dt>Declared</dt>
                  <dd><span className="sn-val">{drift.declared}</span> <span className="sn-vs-src mono">{file.path}</span></dd>
                </div>
                <div>
                  <dt>Observed</dt>
                  <dd>
                    {drift.observed === null
                      ? <span className="sn-val sn-val-none">no name of its own</span>
                      : <span className="sn-val">{drift.observed}</span>}{' '}
                    <span className="sn-vs-src mono">{file.container}</span>
                  </dd>
                </div>
              </dl>
              <p className="sn-note">{APPLY.why}</p>
              <p className="sn-note">{APPLY.how}</p>

              <p className="sn-sub">Run this on the box</p>
              <div className="sn-cmd">
                <code className="mono">{recreateCommand(file)}</code>
                <button type="button" className="sn-copy" onClick={onCopy}
                  aria-label={copied ? 'Command copied' : 'Copy the recreate command'}>
                  {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>

              <p className="sn-sub">What Bothy can do from here</p>
              <p className="sn-note">{APPLY.restartCaveat}</p>
              <div className="sn-row">
                <button
                  type="button"
                  className="btn ghost"
                  onClick={onRestart}
                  disabled={apply.t === 'working' || !canAct}
                  title={canAct ? undefined : 'Restarting a service needs the operator role.'}
                >
                  <RotateCw size={15} aria-hidden="true" />
                  {apply.t === 'working' ? 'Restarting…' : `Restart ${file.container}`}
                </button>
                {!sessionLoading && !canAct && (
                  <span className="sn-note sn-inline">
                    Needs the operator role, which this session does not hold.
                  </span>
                )}
              </div>
              {apply.t === 'done' && (
                <p className="sn-note" role="status">
                  Restarted {file.container}: {apply.res.from} to {apply.res.to}. The label did not
                  move, as above - this notice is still correct.
                </p>
              )}
              {apply.t === 'failed' && (
                <div className="sn-out" data-ok="false" role="status">
                  <p className="sn-out-h">{apply.refusal.title}</p>
                  <p className="sn-note">{apply.refusal.detail}</p>
                </div>
              )}
            </section>
          )}

          {/* ── the form ───────────────────────────────────────────────────── */}
          <form
            className="sn-form"
            onSubmit={(e) => { e.preventDefault(); if (canSave) void onSave(); }}
          >
            <label className="sn-label" htmlFor="sn-name">Name</label>
            <div className="sn-field">
              <input
                id="sn-name"
                className="sn-input"
                type="text"
                value={draft}
                maxLength={site.maxLength}
                spellCheck={false}
                readOnly={!canEdit}
                aria-describedby="sn-hint"
                aria-invalid={localRefusal ? true : undefined}
                onChange={(e) => { touched.current = true; setDraft(e.target.value); setSave({ t: 'rest' }); }}
              />
              {canEdit && (
                <button type="submit" className="btn" disabled={!canSave}>
                  {save.t === 'saving' ? 'Saving…' : 'Save name'}
                </button>
              )}
            </div>
            <p className="sn-hint" id="sn-hint">
              <FileText size={13} aria-hidden="true" />
              <span>
                <span className="mono">{PROJECT_TITLE_FIELD}</span> on service{' '}
                <span className="mono">{site.service}</span>, line {site.line} of{' '}
                <Link className="link" to={filesHref}>{filePath}</Link>. At most {site.maxLength}{' '}
                characters.
              </span>
            </p>
            {localRefusal && <p className="sn-bad" role="status">{localRefusal}</p>}
          </form>

          {!sessionLoading && !canEdit && (
            <div className="sn-norole">
              <p className="sn-h">
                {me ? 'This is read-only for you.' : 'Sign in to change this name.'}
              </p>
              <p className="sn-note">
                {me
                  ? 'Changing a declared value needs the editor role, and this session does not hold '
                    + 'it. The edge would refuse the write before it reached the config service.'
                  : 'Nothing here knows who you are yet, so the edge would refuse a write before it '
                    + 'reached anything. Signing in returns you to this page.'}
              </p>
              {me ? (
                <p className="sn-note">
                  <Link className="link" to="/settings">Settings</Link> lists the four roles and what
                  each one permits. They are granted in Keycloak, not here.
                </p>
              ) : (
                <a className="btn primary sn-signin" href={signInHref()}>
                  <LogIn size={15} aria-hidden="true" />
                  Sign in
                </a>
              )}
            </div>
          )}

          {/* ── what the save did ──────────────────────────────────────────── */}
          {save.t === 'saved' && save.res.changed && (
            <div className="sn-out" data-ok="true" role="status">
              <p className="sn-out-h">Saved to {save.res.path}.</p>
              <p className="sn-note">
                {save.res.previous ? <>It said &ldquo;{save.res.previous}&rdquo; before. </> : null}
                {save.res.snapshot
                  ? 'The previous bytes were kept, so this is undoable.'
                  : 'No copy of the previous bytes was kept - the undo net did not take one.'}
                {save.res.author ? ` Recorded against ${save.res.author}.` : ''}
              </p>
            </div>
          )}
          {save.t === 'saved' && !save.res.changed && (
            <div className="sn-out" data-ok="true" role="status">
              <p className="sn-out-h">That is already what the file says.</p>
              <p className="sn-note">
                Nothing was written, on purpose: a write would move the file&rsquo;s timestamp and
                make every other form open on it report a conflict it does not have.
              </p>
            </div>
          )}
          {save.t === 'failed' && (
            <RefusalBlock
              refusal={save.refusal}
              signedIn={!!me}
              onReload={save.refusal.conflict ? () => { setSave({ t: 'rest' }); read(); } : undefined}
            />
          )}
        </>
      )}
    </div>
  );
}

/** Every refusal reads the same way: what happened, why, what to do next. The
 *  only branch is whether the next thing is a session, a role, or a reload. */
function RefusalBlock({
  refusal, signedIn, onReload,
}: { refusal: Refusal; signedIn: boolean; onReload?: () => void }) {
  return (
    <div className="sn-out" data-ok="false" role="status">
      <p className="sn-out-h">{refusal.title}</p>
      <p className="sn-note">{refusal.detail}</p>
      {refusal.conflict && refusal.conflict.theirs.length > 0 && (
        <dl className="sn-vs">
          <div>
            <dt>On disk now</dt>
            <dd><span className="sn-val">{refusal.conflict.theirs[0].value}</span></dd>
          </div>
          <div>
            <dt>Yours</dt>
            <dd><span className="sn-val">{refusal.conflict.yours}</span></dd>
          </div>
        </dl>
      )}
      {onReload && (
        <div className="sn-row">
          {/* The draft is deliberately kept. Reloading answers "what does it say
              now"; it does not throw away what somebody typed, because that
              would make the safe move the expensive one. */}
          <button type="button" className="btn ghost" onClick={onReload}>Reload the file</button>
          <span className="sn-note sn-inline">What you typed stays in the box.</span>
        </div>
      )}
      {refusal.needs === 'sign-in' && (
        <a className="btn primary sn-signin" href={signInHref()}>
          <LogIn size={15} aria-hidden="true" />
          Sign in
        </a>
      )}
      {(refusal.needs === 'editor' || refusal.needs === 'viewer') && signedIn && (
        <p className="sn-note">
          <Link className="link" to="/settings">Settings</Link> lists the four roles and what each one
          permits. They are granted in Keycloak, not here.
        </p>
      )}
    </div>
  );
}
