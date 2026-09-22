// The person control in the topbar's right cluster.
//
// Two states and no third: signed in it is a menu button carrying the name the
// session says you have; signed out it is a link into the sign-in flow. There is
// deliberately no visible "checking…" state - a control that reads "Sign in" for
// eighty milliseconds and then reads "devssh" has told the user something false,
// so the trigger holds the glyph alone until the answer lands and only then
// grows a name.
//
// WHAT THE INTERFACE HIDES IS NEVER WHAT THE API ENFORCES. The roles this menu
// lists are for the reader. Hiding a control that the user's role forbids saves
// a round trip and a 403 and nothing else; the decision is taken at the edge by
// a forwardAuth middleware reading a signed cookie, which never trusts the
// browser. If this component is ever the only thing between a user and an
// action, that action is unprotected.
//
// NO SHARED Tooltip HERE, and for a different reason than the one written down
// in pages/files/ActivityBar.tsx (that one is about a 46px strip clipping the
// bubble). Tooltip opens on `onFocusCapture` and draws inside its own wrapper -
// so wrapping a menu button in it means the bubble pins itself open the instant
// the menu takes focus, on top of the menu it just opened. `title` plus the
// button's accessible name carries the same words; only the styling is lost.
//
// ON ui/Menu SINCE BATCH 3 (design audit SYS-5, 2026-09-22). This used to
// copy OverflowMenu's hand-written keyboard model "down to the Tab trap" so the
// two would agree; both now agree by being the same primitive - which closes on
// Tab rather than trapping it, per the APG menu pattern (FL-21), grows out of
// this button and goes back into it.
import { useEffect, useState } from 'react';
import { LogIn, LogOut, Settings2, UserRound } from 'lucide-react';
import { fetchMe, signInHref, signOutHref, type Me } from '../lib/me';
import { useUpdatesBehind } from './settings/useUpdatesBehind';
import { Menu } from './ui/Menu';
import './UserMenu.css';

export function useMe(): { me: Me | null; loading: boolean } {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const ac = new AbortController();
    fetchMe(ac.signal)
      .then((m) => { if (!ac.signal.aborted) { setMe(m); setLoading(false); } })
      .catch(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, []);
  return { me, loading };
}

export function UserMenu() {
  const { me, loading } = useMe();
  // Radix owns open/closed now; this flag (set on the first open) exists only so the Updates count is
  // asked for once the menu is OPEN (docs/plans/updates.md §8) and only for a
  // session holding viewer - every page load is not a reason to read it.
  const [opened, setOpen] = useState(false);
  const behind = useUpdatesBehind(opened && !!me?.roles.includes('viewer'));

  // Signed out. An <a>, never a button with an onClick: the sign-in flow is a
  // full navigation through oauth2-proxy to Keycloak and back, so it wants the
  // browser's own semantics - middle-click, Back, and a status bar that says
  // where it goes.
  if (!loading && !me) {
    return (
      // Wrapped in .user-menu even with no menu to open: every rule in the
      // stylesheet is scoped under it, so an unwrapped trigger would be styled
      // by .icon-btn alone and come out a 38px square with the label clipped.
      <div className="user-menu">
        <a className="icon-btn user-btn" href={signInHref()} title="Sign in">
          <LogIn size={18} aria-hidden="true" />
          <span className="user-name">Sign in</span>
        </a>
      </div>
    );
  }

  const label = me ? `${me.preferredUsername} - account and roles` : 'Checking your session';
  const trigger = (
    <button
      type="button"
      className="icon-btn user-btn"
      aria-label={label}
      title={label}
      // Nothing to open until the session answers, but the control keeps its
      // size throughout so the topbar does not shuffle when it does.
      disabled={!me}
    >
      <UserRound size={18} aria-hidden="true" />
      {me && <span className="user-name">{me.preferredUsername}</span>}
    </button>
  );

  return (
    <div className="user-menu">
      {!me ? trigger : (
        <Menu
          className="um-pop"
          // The identity block below is not a menuitem, and a screen reader in
          // menu mode may never read it - so who you are is said on the menu
          // itself, as well as drawn in it.
          label={`Signed in as ${me.preferredUsername}`}
          trigger={trigger}
          onOpenChange={(o) => { if (o) setOpen(true); }}
          header={(
            <div className="um-who">
              <span className="um-who-name">{me.preferredUsername}</span>
              <span className="um-who-mail">{me.email}</span>
              {/* The roles held, and only those - the full four with what each
                  permits is the Settings page's job, one row below. */}
              <span className="um-roles">
                {me.roles.length > 0
                  ? me.roles.map((r) => <span className="tag" key={r}>{r}</span>)
                  : <span className="um-noroles">No roles granted</span>}
              </span>
            </div>
          )}
          items={[
            {
              // A real link (HashRouter: the fragment IS the route), so
              // middle-click opens Settings in a new tab as it always did.
              key: 'settings', href: '#/settings', label: 'Settings',
              icon: <Settings2 size={15} />,
              trailing: behind !== null && behind > 0 ? (
                <span className="um-count" title={`Updates: ${behind} a minor version or more behind`}>
                  {behind}<span className="sr-only"> updates a minor version or more behind</span>
                </span>
              ) : undefined,
            },
            { key: 'signout', href: signOutHref(), label: 'Sign out', icon: <LogOut size={15} /> },
          ]}
        />
      )}
    </div>
  );
}
