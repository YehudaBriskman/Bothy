// The session, fetched ONCE for the whole tab.
//
// components/UserMenu.tsx already exports a `useMe()`, and this is not a rename
// of it. That one mounts twice in the app - the topbar control and the Settings
// page - so a fetch per mount costs two requests and reads clearly where it is.
// This one is asked by every action dialog that opens, and a page where somebody
// is starting six stopped containers would ask six times for an answer that
// cannot have changed. One promise at module scope is the smallest thing that
// fixes that; a context would need a provider in main.tsx and would re-render
// every row when the answer landed.
//
// A DEAD END WORTH RECORDING: the first shape put this check on the row control
// itself, so a row could be drawn inert before it was clicked. That is one
// identity fetch per row - forty on the Services page - for a control that is
// transparent until you hover it, and it made "you may not do this" a thing the
// table asserted about rows nobody had asked about. The check moved into the
// dialog, where it is one fetch on demand and the reason is next to the verbs it
// explains, and the shared promise stayed because it costs four lines.
//
// It is deliberately not refreshed. A session that expires mid-page shows up as
// the 403 the action itself returns, which is the honest place for it: the edge
// decided, and the page found out by being told.
//
// WHAT THE INTERFACE HIDES IS NEVER WHAT THE API ENFORCES. `canAct` below decides
// whether a button is drawn enabled. It has never stopped a request and cannot:
// every call to /-/api/control/* is gated at the edge by a forwardAuth middleware
// reading a signed cookie, which does not trust anything the browser says. This
// is a courtesy that saves a round trip and turns a bare 403 into a sentence
// explaining, in advance, why the answer would have been no.

import { useEffect, useState } from 'react';
import { fetchMe, hasRole, type Me } from './me';

let shared: Promise<Me | null> | null = null;

function session(): Promise<Me | null> {
  // A rejection is not cached: a network blip on the first render would
  // otherwise make the whole tab permanently believe it is signed out.
  if (!shared) shared = fetchMe().catch((e) => { shared = null; throw e; });
  return shared;
}

export interface Operator {
  me: Me | null;
  /** True until the session has answered. Nothing role-dependent should be drawn
   *  before it flips, or the control says "sign in" for eighty milliseconds and
   *  then contradicts itself. */
  loading: boolean;
  /** Whether to draw the verbs enabled. Never whether they are permitted. */
  canAct: boolean;
}

export function useOperator(): Operator {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    session()
      .then((m) => { if (live) { setMe(m); setLoading(false); } })
      // Being unable to ask is not being signed out, but there is no third state
      // worth drawing: both end at "you cannot act from here", and the action
      // itself will say which if it is tried.
      .catch(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  // DEV ONLY, and a literal `false` after a build so the block is not in the
  // bundle. `vite dev` proxies /oauth2/* at a box this browser holds no cookie
  // for, so every session is signed out and the operator path could not be
  // looked at while it was being built. Set it from the console:
  //   localStorage['bothy-dev-roles'] = 'viewer,operator'
  // Delete the key to go back to the real answer. It changes what is DRAWN and
  // nothing else, which is the same sentence that is true of the role layer in
  // production.
  if (import.meta.env.DEV) {
    let raw: string | null = null;
    try { raw = localStorage.getItem('bothy-dev-roles'); } catch { raw = null; }
    if (raw !== null) {
      return { me, loading, canAct: raw.split(',').some((r) => r.trim() === 'operator') };
    }
  }

  return { me, loading, canAct: hasRole(me, 'operator') };
}
