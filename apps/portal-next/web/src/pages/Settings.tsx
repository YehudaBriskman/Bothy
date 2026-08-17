// Settings - who you are, and what that lets you do.
//
// READ-ONLY, and that is the design rather than a stage it is passing through.
// The page separates three things that the word "settings" usually collapses:
//
//   · theme and pane widths belong to the BROWSER, live in localStorage, and are
//     already correct there - a pane width is a fact about the screen you are
//     sitting at, and following you to a phone would be the bug;
//   · identity and roles belong to the USER, arrive with the session, and are
//     changed in the realm rather than here;
//   · everything else - a default root, a landing page, favourites - belongs
//     nowhere yet, because no preference store exists.
//
// So the page says all three plainly. What it does NOT do is render a greyed-out
// form labelled "coming soon": a control that cannot work is a promise the page
// has no way to keep, and a sentence saying why is both shorter and true.
//
// A store would be a write path, and a write path is a threat model, an audit
// trail and a boundary - see docs/plans/control-and-settings.md §6b. It is worth
// paying for when there is a preference somebody actually wants kept, and this
// page exists partly to make that moment obvious when it arrives.

import { Ban, Circle, CircleCheck, LogIn } from 'lucide-react';
import { ROLES, ROLE_MEANING, signInHref, type Me, type Role } from '../lib/me';
import { useMe } from '../components/UserMenu';
import { useTheme } from '../lib/theme';
import { THEME_DIR_HOST } from '../lib/customThemes';
import { ThemeSwatch } from '../components/ThemeSwatch';
import { Skeleton } from '../components/states';
import './Settings.css';

export function Settings() {
  const { me, loading } = useMe();

  return (
    <div className="page settings-page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="page-sub">Who you are, what that lets you do, and where each of those facts is kept.</p>
        </div>
      </div>

      {loading ? <Skeleton variant="panels" /> : me ? <You me={me} /> : <SignedOut />}

      {/* Appearance is the ONE control on this page, and it is here because the
          topbar button stopped being able to express the choice. A cycle button
          works for two states; with a registry of themes behind it, cycling to
          get back to where you started is the whole interaction. The button
          stays as the quick dark/light/system toggle, and the list lives here.

          It is not a contradiction of the read-only rule. That rule is about a
          SERVER-side preference store - a write path, an audit trail, a
          boundary. This writes one key to localStorage in this browser, which is
          the same thing the topbar button has always done. */}
      <Appearance />

      {/* Both of these are statements about the box, not about the visitor, so
          they render whether or not there is a session to describe. Someone
          signed out is the reader most likely to want to know where the sign-in
          they are about to do actually goes. */}
      <Session />
      <Storage />
    </div>
  );
}

function Appearance() {
  const { selection, theme, themes, setSelection } = useTheme();
  const custom = themes.filter((t) => t.user).length;

  // System first, then the themes. It is the only entry that is not a palette -
  // it is a rule for picking one - so it gets said in words rather than given a
  // swatch row that would imply it had colours of its own.
  return (
    <section className="panel">
      <h2 className="panel-h">Appearance</h2>
      <div className="panel-b">
        <p className="set-lede">
          Kept in this browser. The topbar button still toggles dark, light and system;
          this is where the rest of them live.
        </p>

        {/* The only instruction on this page, and it earns its place: a theme
            you add is a FILE, and nothing else on screen would tell you where
            it goes. Deliberately a host path rather than a container one -
            the person who needs this sentence is standing in the repo. */}
        <p className="set-note">
          Add your own by dropping a <code className="mono">.css</code> file into{' '}
          <code className="mono">{THEME_DIR_HOST}</code> on the box and reloading.
          One file is the whole theme, and it survives a rebuild — copy an existing
          one to start.{' '}
          {custom === 0
            ? 'Nothing is there yet.'
            : custom === 1
              ? 'One theme below came from there.'
              : `${custom} of the themes below came from there.`}
        </p>

        <div className="theme-grid" role="radiogroup" aria-label="Theme">
          <button
            type="button"
            role="radio"
            aria-checked={selection === 'system'}
            className={`theme-card ${selection === 'system' ? 'is-on' : ''}`}
            onClick={() => setSelection('system')}
          >
            <span className="theme-name">System</span>
            <span className="theme-note">
              Follow the desktop. Currently {theme.name.replace(/^Bothy /, '').toLowerCase()}.
            </span>
          </button>

          {themes.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={selection === t.id}
              className={`theme-card ${selection === t.id ? 'is-on' : ''}`}
              onClick={() => setSelection(t.id)}
            >
              <span className="theme-name">
                {t.name}
                {t.user && <span className="theme-tag">yours</span>}
              </span>
              <span className="theme-note">{t.note}</span>
              <ThemeSwatch id={t.id} />
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

// The same shape ServiceDetail uses for a labelled fact, deliberately copied
// rather than shared: it is six lines wrapping three divs, and a common module
// for it would make two unrelated pages import each other's layout.
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="kv">
      <div className="kv-k">{label}</div>
      <div className="kv-v">{children}</div>
    </div>
  );
}

function SignedOut() {
  return (
    <section className="panel">
      <h2 className="panel-h">You are not signed in</h2>
      <div className="panel-b">
        <p className="set-lede">
          Nothing here knows who you are yet. Signing in returns you to this page, which will
          then say which of the four roles your account holds and what each one permits.
        </p>
        <a className="btn primary" href={signInHref()}>
          <LogIn size={15} aria-hidden="true" />
          Sign in
        </a>
      </div>
    </section>
  );
}

function You({ me }: { me: Me }) {
  // Everything the token carries that is NOT one of the four realm roles:
  // Keycloak's own bookkeeping (`default-roles-devbox`, `uma_authorization`,
  // `offline_access`). Noise most days, and exactly what you want to read on the
  // day a token looks wrong - so it is shown, quietly, and never as a role.
  const other = me.groups.filter((g) => !(ROLES as readonly string[]).includes(g));

  return (
    <>
      <section className="panel">
        <h2 className="panel-h">You</h2>
        <div className="panel-b">
          <div className="kv-list">
            <Field label="Username">{me.preferredUsername}</Field>
            <Field label="Email">{me.email || <span className="dim">none on the token</span>}</Field>
            {/* The durable one, and the reason it is on the page at all: a
                username can be renamed and an email reassigned, but every log
                line and every token is about this. It is what to quote when one
                of the other two disagrees with what a service thinks. Small and
                muted, because it is the field you need on one day in a hundred. */}
            <Field label="Subject">
              <span className="mono set-sub">{me.user}</span>
              <span className="set-note">
                The durable identifier. The username and the email can change; this cannot.
              </span>
            </Field>
            {other.length > 0 && (
              <Field label="Other groups">
                <span className="mono set-sub">{other.join(' · ')}</span>
                <span className="set-note">Keycloak&rsquo;s own bookkeeping. None of these grants anything here.</span>
              </Field>
            )}
          </div>
        </div>
      </section>

      <section className="panel">
        <h2 className="panel-h">
          What you may do
          {/* Not "3 of 4". One of the four is granted to nobody, so a
              denominator would state a total that cannot be reached. */}
          <span className="sub">{me.roles.length} held</span>
        </h2>
        <div className="panel-b">
          {/* THE ONE RULE TO CARRY OUT OF THIS FILE: what the interface hides is
              never what the API enforces. This list is a description of a token,
              not a permission check. Every action on this box is gated at the
              edge by a forwardAuth middleware reading a signed cookie, and a
              role missing from this page has never stopped a request - it only
              explains, in advance, the 403 that would have come back. */}
          <ul className="roles">
            {ROLES.map((r) => <RoleRow key={r} role={r} held={me.roles.includes(r)} />)}
          </ul>
        </div>
      </section>
    </>
  );
}

function RoleRow({ role, held }: { role: Role; held: boolean }) {
  // `shell` is not an absence you can fix by asking. The realm defines it and
  // grants it to nobody, on purpose, so rendering it as a plain "not held"
  // beside `operator` would invite exactly the wrong question. Written as a
  // condition rather than a constant because if it is ever granted, this page
  // must say so rather than keep insisting nobody has it.
  const ungrantable = role === 'shell' && !held;
  const state = held ? 'Held' : ungrantable ? 'Granted to nobody' : 'Not held';
  const Mark = held ? CircleCheck : ungrantable ? Ban : Circle;

  return (
    // Held and not-held are STATE, so the reserved status palette is legal here
    // (--st-up for held, --st-off for not - the quiet token, because not holding
    // a role is not a fault). Colour is still never the only encoder: the glyph
    // differs, and the word is written out beside it.
    <li className="role" data-held={held ? 'yes' : 'no'}>
      <Mark size={17} className="role-mark" aria-hidden="true" />
      <div className="role-text">
        <p className="role-line">
          <span className="role-id mono">{role}</span>
          <span className="role-state">{state}</span>
        </p>
        <p className="role-why">{ROLE_MEANING[role]}</p>
      </div>
    </li>
  );
}

function Session() {
  // Built from the host actually being browsed rather than a baked-in address,
  // because this box is reached at its tailnet IP and the SPA has no other way
  // to know it. On a Vite dev server that resolves to localhost:8090 and points
  // at nothing - which is consistent with the rest of identity here, since the
  // session cookie is host-only and there is no session on localhost either.
  //
  // The account console is linked because it was checked: /realms/devbox/account
  // answers 200 over plain HTTP. Keycloak's /admin does not - it refuses without
  // HTTPS on this box - so that one is deliberately not offered.
  const kc = `http://${location.hostname}:8090`;

  return (
    <section className="panel">
      <h2 className="panel-h">Where this session comes from</h2>
      <div className="panel-b">
        <div className="kv-list">
          <Field label="Issued by">
            Keycloak, realm <span className="mono">devbox</span>, at <span className="mono">{kc}</span>
            <span className="set-note">
              <a className="link" href={`${kc}/realms/devbox/account`}>Account console</a>
              {' '}- password, sessions and devices are changed there, not here.
            </span>
          </Field>
          <Field label="Carried by">
            oauth2-proxy, asked by Traefik on every request
            <span className="set-note">
              A host-only cookie. No cookie domain is set, because every service on this box is a
              different port on one host - so a session on the box&rsquo;s address is not a session on
              localhost.
            </span>
          </Field>
          <Field label="Enforced by">
            <span className="mono">sso-viewer</span> and <span className="mono">sso-editor</span>,
            forwardAuth middlewares at the edge
            <span className="set-note">
              Not by this page. The list above describes your token; the refusal, when it comes,
              is decided before a request ever reaches an application.
            </span>
          </Field>
        </div>
      </div>
    </section>
  );
}

const STORES = [
  {
    what: 'Theme, and the widths of the panes in Files',
    where: 'This browser',
    store: 'localStorage',
    why: 'Per browser is the right home for these, not a limitation. A pane width is a fact about the '
      + 'screen you are sitting at; carrying it to a phone would be the bug. They are changed where '
      + 'they are used - the theme button in the topbar, the panes themselves - rather than here.',
  },
  {
    what: 'Your username, email, subject id and roles',
    where: 'Your account',
    store: 'Keycloak',
    why: 'Per user, and read-only here. They arrive with the session and are changed in the realm. '
      + 'This page has no way to write them, which is the point.',
  },
  {
    what: 'A default root, a landing page, a list of favourites',
    where: 'Nowhere',
    store: 'no store exists',
    why: 'Deliberately not built. None of these has been asked for yet, and a preference store is a '
      + 'write path - which needs a threat model, an audit trail and a boundary before it needs a form.',
  },
];

function Storage() {
  return (
    <section className="panel">
      <h2 className="panel-h">What is stored where</h2>
      <div className="panel-b">
        <ul className="stores">
          {STORES.map((s) => (
            <li className="store" key={s.what}>
              <p className="store-what">{s.what}</p>
              <p className="store-where">
                {s.where}
                <span className="mono store-store">{s.store}</span>
              </p>
              <p className="store-why">{s.why}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
