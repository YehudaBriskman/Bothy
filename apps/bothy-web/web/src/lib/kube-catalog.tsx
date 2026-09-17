// React glue for the cluster tier: the catalog, the roles, and a polled read.
//
// Kept apart from lib/kube-actions.ts so that module stays import-free enough
// for checks/run.sh to compile it with a bare tsc and run it in node.

import { useCallback, useEffect, useRef, useState } from 'react';
import { kubeGet, kubeRefusalOf, loadCatalog, type KubeCatalog, type KubeRefusal } from './kube-actions';
import { useOperator } from './session';
import type { Me } from './me';

export interface CatalogState {
  catalog: KubeCatalog | null;
  refusal: KubeRefusal | null;
}

/** The catalog from GET /-/api/kube/catalog, once per tab. */
export function useKubeCatalog(): CatalogState {
  const [state, setState] = useState<CatalogState>({ catalog: null, refusal: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    loadCatalog().then(
      (catalog) => { if (live) setState({ catalog, refusal: null }); },
      (e) => {
        if (!live) return;
        setState({ catalog: null, refusal: kubeRefusalOf(e, { title: 'Read the catalog of', role: 'viewer' }, 'cluster actions') });
        // The catalog is what every tab draws from; without it the page has
        // nothing to offer, so it keeps asking (slowly) rather than giving up.
        retry = setTimeout(() => setNonce((n) => n + 1), 20_000);
      },
    );
    return () => { live = false; clearTimeout(retry); };
  }, [nonce]);
  return state;
}

/** Roles for DRAWING. The dev override matches lib/session.ts's key. */
export function useKubeRoles(): { roles: string[]; loading: boolean; me: Me | null } {
  const { me, loading } = useOperator();
  if (import.meta.env.DEV) {
    let raw: string | null = null;
    try { raw = localStorage.getItem('bothy-dev-roles'); } catch { raw = null; }
    if (raw !== null) return { roles: raw.split(',').map((r) => r.trim()).filter(Boolean), loading: false, me };
  }
  return { roles: me?.roles ?? [], loading, me };
}

export interface ReadState<T> {
  data: T | null;
  refusal: KubeRefusal | null;
  loading: boolean;
  /** When the last successful answer arrived (epoch ms). */
  at: number | null;
  reload: () => void;
}

/**
 * A polled GET. Pauses while the tab is hidden, re-reads on return, and NEVER
 * clears the last good answer on a failure - a stale table with a note beats an
 * empty one on the page you open when something is wrong.
 *
 * `key` is the identity of the request (action + namespace + target); a change
 * of key drops the old data, because that is a different question.
 */
export function useKubeRead<T>(
  id: string | null, req: Record<string, unknown>, intervalMs = 15_000,
): ReadState<T> {
  const key = id ? `${id}?${JSON.stringify(req)}` : '';
  const [state, setState] = useState<{ key: string; data: T | null; refusal: KubeRefusal | null; loading: boolean; at: number | null }>(
    { key, data: null, refusal: null, loading: !!id, at: null },
  );
  const [nonce, setNonce] = useState(0);
  const reqRef = useRef(req);
  reqRef.current = req;

  useEffect(() => {
    if (!id) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState((s) => (s.key === key ? { ...s, loading: true } : { key, data: null, refusal: null, loading: true, at: null }));
    const run = () => {
      kubeGet<T>(id, reqRef.current).then(
        (data) => { if (live) setState({ key, data, refusal: null, loading: false, at: Date.now() }); },
        (e) => {
          if (live) {
            setState((s) => ({ ...s, key, loading: false, refusal: kubeRefusalOf(e, { title: `Read ${id} of`, role: 'viewer' }, String(reqRef.current.namespace ?? '')) }));
          }
        },
      ).finally(() => {
        if (live && intervalMs > 0 && !document.hidden) timer = setTimeout(run, intervalMs);
      });
    };
    const onVisible = () => { if (!document.hidden) { clearTimeout(timer); run(); } };
    document.addEventListener('visibilitychange', onVisible);
    run();
    return () => { live = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [id, key, nonce, intervalMs]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const same = state.key === key;
  return { data: same ? state.data : null, refusal: same ? state.refusal : null, loading: same ? state.loading : !!id, at: same ? state.at : null, reload };
}
