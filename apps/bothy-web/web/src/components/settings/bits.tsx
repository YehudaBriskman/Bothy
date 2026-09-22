// Small pieces every Settings page uses: a copyable command, a relative time with
// the absolute one available, a refusal in words, a labelled fact, a choice group,
// and a hook for one async read.

import { Loader } from '../ui/Loader';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, LogIn } from 'lucide-react';
import { refusalOf, statusOf } from '../../lib/http';
import { signInHref } from '../../lib/me';
import { relDate } from '../../lib/files';
import { buttonClass } from '../ui/Button';
import { Icon } from '../ui/Icon';

/** A command to run on the box. Never a button that runs it: rotation and
 *  backups stay a shell's job in v1, and the page says the command out loud. */
export function Cmd({ children }: { children: string }) {
  const [done, setDone] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(children).then(
      () => { setDone(true); setTimeout(() => setDone(false), 1400); },
      () => { /* a refused clipboard is not worth a message: the text is selectable */ },
    );
  }, [children]);
  return (
    <span className="set-cmd">
      <code className="mono">{children}</code>
      <button type="button" className="set-cmd-copy" onClick={copy} aria-label={`Copy: ${children}`} title="Copy">
        {done ? <Icon icon={Check} size="sm" /> : <Icon icon={Copy} size="sm" />}
      </button>
    </span>
  );
}

/** Backticked spans in a sentence become copyable commands. Used for the rotation
 *  procedures, which are prose with commands inside them. */
export function Prose({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) => (p.startsWith('`') && p.endsWith('`') && p.length > 2
        ? <Cmd key={i}>{p.slice(1, -1)}</Cmd>
        : <span key={i}>{p}</span>))}
    </>
  );
}

export function When({ iso, empty = 'never' }: { iso: string | null | undefined; empty?: string }) {
  if (!iso) return <span className="dim">{empty}</span>;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return <span>{iso}</span>;
  return <time dateTime={iso} title={d.toLocaleString()}>{relDate(iso)}</time>;
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv">
      <div className="kv-k">{label}</div>
      <div className="kv-v">{children}</div>
    </div>
  );
}

/**
 * A refusal, by what to do next. The edge's 401/403 are not JSON (lib/http.ts),
 * so the status decides; a service refusal carries its own sentence, shown as
 * written - that is where "run `just admin-client`" comes from.
 */
export function Refusal({ error, needs, what }: { error: unknown; needs?: string; what: string }) {
  const status = statusOf(error);
  const kind = refusalOf(status);
  const message = error instanceof Error ? error.message : String(error);
  const fromService = !!(error as { fromService?: boolean } | null)?.fromService;
  if (kind === 'sign-in') {
    return (
      <div className="set-refusal" role="status">
        <p><b>Sign in to see {what}.</b> Nothing here is shown without a session.</p>
        <a className={buttonClass({ variant: 'ghost', size: 'sm' })} href={signInHref()}><Icon icon={LogIn} size="sm" /> Sign in</a>
      </div>
    );
  }
  if (kind === 'role') {
    return (
      <div className="set-refusal" role="status">
        <p><b>Your session does not hold <span className="mono">{needs ?? 'the role'}</span>.</b>{' '}
          The edge refused before the request reached a service. A role granted after you signed in is picked up by
          signing out and back in.</p>
      </div>
    );
  }
  if (kind === 'silent') {
    return (
      <div className="set-refusal" role="status">
        <p><b>Nothing answered for {what}.</b>{' '}
          {fromService ? message : 'Either the box is unreachable, or the route is not deployed yet - the portal answers unrouted paths with its own page.'}</p>
      </div>
    );
  }
  return (
    <div className="set-refusal" role="status" data-kind={kind}>
      <p><b>{kind === 'unavailable' ? `${what[0].toUpperCase()}${what.slice(1)} are unavailable right now.` : `Could not load ${what}.`}</b>{' '}
        {fromService ? <Prose text={message} /> : `The request was refused with ${status}.`}</p>
    </div>
  );
}

/** One async read, with a retry. `deps` restarts it. */
export function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>(
    { data: null, error: null, loading: true },
  );
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const ac = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    loadRef.current(ac.signal)
      .then((data) => { if (!ac.signal.aborted) setState({ data, error: null, loading: false }); })
      .catch((error) => { if (!ac.signal.aborted) setState({ data: null, error, loading: false }); });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, ...deps]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}

/** A labelled radio group of segmented buttons. */
export function Choice<T extends string | number>({
  label, value, options, onChange, name,
}: {
  label: string;
  name: string;
  value: T;
  options: readonly { value: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="set-choice">
      <legend className="set-choice-l">{label}</legend>
      <div className="set-choice-opts">
        {options.map((o) => (
          <label key={String(o.value)} className={`set-opt ${o.value === value ? 'on' : ''}`}>
            <input
              type="radio"
              name={name}
              checked={o.value === value}
              onChange={() => onChange(o.value)}
            />
            <span className="set-opt-t">{o.label}</span>
            {o.hint && <span className="set-opt-h">{o.hint}</span>}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** A Settings section's first read: row skeletons hold the table's height, the
 *  Loader (ui/Loader, `load`) says it is working and announces what. */
export function Loading({ rows = 3, label = 'Loading…' }: { rows?: number; label?: string }) {
  return (
    <div className="skel-host" aria-busy="true">
      <div className="skel-col set-skel" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => <div className="skel" key={i} style={{ height: 30 }} />)}
      </div>
      <Loader state="load" size={rows > 2 ? 'md' : 'sm'} label={label} center className="skel-orb" />
    </div>
  );
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null || n < 0 || !Number.isFinite(n)) return '-';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}
