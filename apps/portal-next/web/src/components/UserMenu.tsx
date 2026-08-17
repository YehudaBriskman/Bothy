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
// The keyboard model is OverflowMenu's (pages/files/Menu.tsx) on purpose, down
// to the Tab trap. Two menus on one box that answer the arrow keys differently
// is a worse cost than the duplication. They are not merged because that one is
// scoped to `.bothy-files`, is driven by a MenuItem[] and knows about keyboard
// chords; this one is a fixed identity block over two rows, and generalising it
// into the same component would leave neither call site readable.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LogIn, LogOut, Settings2, UserRound } from 'lucide-react';
import { fetchMe, signInHref, signOutHref, type Me } from '../lib/me';
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
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const btn = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const id = useId();

  const close = useCallback((toButton: boolean) => {
    setOpen(false);
    if (toButton) btn.current?.focus();
  }, []);

  // A pointer press outside. `pointerdown` rather than `click`, so the menu is
  // gone before whatever sits under it reacts.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  // Focus lands on the first row when it opens, or the arrow keys look ignored.
  useEffect(() => {
    if (!open) return;
    setAt(0);
    list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  const rows = () => Array.from(
    list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
  );
  const move = (to: number) => {
    const r = rows();
    if (!r.length) return;
    const i = ((to % r.length) + r.length) % r.length;
    setAt(i);
    r[i]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'Escape': e.preventDefault(); close(true); break;
      case 'ArrowDown': e.preventDefault(); move(at + 1); break;
      case 'ArrowUp': e.preventDefault(); move(at - 1); break;
      case 'Home': e.preventDefault(); move(0); break;
      case 'End': e.preventDefault(); move(rows().length - 1); break;
      // Tab out of an open menu and the panel is still on screen with the focus
      // somewhere behind it. So Tab moves within, like the arrows.
      case 'Tab': e.preventDefault(); move(at + (e.shiftKey ? -1 : 1)); break;
      default: break;
    }
  };

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

  return (
    <div className="user-menu" ref={wrap}>
      <button
        type="button"
        ref={btn}
        className={`icon-btn user-btn ${open ? 'on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        title={label}
        // Nothing to open until the session answers, but the control keeps its
        // size throughout so the topbar does not shuffle when it does.
        disabled={!me}
        onClick={() => setOpen((v) => !v)}
      >
        <UserRound size={18} aria-hidden="true" />
        {me && <span className="user-name">{me.preferredUsername}</span>}
      </button>

      {open && me && (
        <div
          className="um-panel"
          role="menu"
          id={id}
          // The identity block below is not a menuitem, and a screen reader in
          // menu mode may never read it - so who you are is said here, on the
          // menu itself, as well as drawn in it.
          aria-label={`Signed in as ${me.preferredUsername}`}
          ref={list}
          onKeyDown={onKeyDown}
        >
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

          <Link
            className="um-item"
            role="menuitem"
            tabIndex={at === 0 ? 0 : -1}
            to="/settings"
            onFocus={() => setAt(0)}
            onClick={() => close(false)}
          >
            <Settings2 size={15} aria-hidden="true" />
            <span>Settings</span>
          </Link>

          <a
            className="um-item"
            role="menuitem"
            tabIndex={at === 1 ? 0 : -1}
            href={signOutHref()}
            onFocus={() => setAt(1)}
          >
            <LogOut size={15} aria-hidden="true" />
            <span>Sign out</span>
          </a>
        </div>
      )}
    </div>
  );
}
