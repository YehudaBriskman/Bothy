// Settings - who you are, what that lets you do, and how this browser looks.
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
//
// ── WHY IT IS GROUPED THE WAY IT IS (2026-08, issue #95) ────────────────────
// The three paragraphs above were always the page's thesis, but the page did not
// look like them. It was five panels at one weight in the order the features
// landed - identity, appearance, session, storage - so the two halves of a
// SINGLE subject (who you are, and where that identity comes from) sat either
// side of an unrelated one, and the reader had to do the grouping the page was
// claiming to have done. Nothing was missing; the structure was.
//
// So the page is now grouped by that same separation rather than by arrival
// order. "You" holds the account, the roles and where the session came from -
// three panels about one subject that used to have the theme picker sitting in
// the middle of them. "Appearance" holds the browser's half. "Where these are
// kept" holds the stores themselves, and the one that deliberately does not
// exist.
//
// Each group is an <h2> and every panel under it an <h3>, which is not
// decoration: it means the document outline and the visual grouping cannot drift
// apart, and a reader jumping by heading lands on three subjects rather than on
// five siblings that look equally important because they are marked up as
// equally important.
//
// The one thing that MOVED rather than being regrouped is where a custom theme
// comes from. The instruction for writing a theme file used to sit above the
// picker, where it interrupted the choice with a paragraph about a directory;
// it is now beside the editor entry, in a panel about making one. Both routes
// to a new theme end at the same .css file in the same directory, which is the
// fact the two of them together are there to say.

import { Ban, Circle, CircleCheck, Code2, LogIn, Minus, Pencil, Plus } from 'lucide-react';
import { ROLES, ROLE_MEANING, signInHref, type Me, type Role } from '../lib/me';
import { useMe } from '../components/UserMenu';
import { useTheme } from '../lib/theme';
import { THEME_DIR_HOST } from '../lib/customThemes';
import { ThemeSwatch } from '../components/ThemeSwatch';
import { Link } from 'react-router-dom';
import { Skeleton } from '../components/states';
import './Settings.css';
import {
  READING_DEFAULT, READING_LIMITS, READING_STEP, useReading, type Reading,
} from './files/reading';

export function Settings() {
  const { me, loading } = useMe();

  return (
    <div className="page settings-page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="page-sub">
            Who you are, what that lets you do, and how this browser looks. Only the last of those is
            changed here.
          </p>
        </div>
      </div>

      <Group
        id="set-g-you"
        title="You"
        lede={
          'Read-only on this page, and deliberately so. All of it arrives with the session, follows you '
          + 'to every browser you sign in on, and is changed in the realm rather than here.'
        }
      >
        {loading ? <Skeleton variant="panels" /> : me ? <You me={me} /> : <SignedOut />}

        {/* A statement about the box rather than about the visitor, so it renders
            whether or not there is a session to describe. Someone signed out is
            the reader most likely to want to know where the sign-in they are
            about to do actually goes - which is why it is inside this group and
            not in a group of its own: "who you are" and "where that came from"
            are one subject, and splitting them was the old page's main fault. */}
        <Session />
      </Group>

      {/* Appearance is the ONE control on this page, and it is here because the
          topbar button stopped being able to express the choice. A cycle button
          works for two states; with a registry of themes behind it, cycling to
          get back to where you started is the whole interaction. The button
          stays as the quick dark/light/system toggle, and the list lives here.

          It is not a contradiction of the read-only rule. That rule is about a
          SERVER-side preference store - a write path, an audit trail, a
          boundary. This writes one key to localStorage in this browser, which is
          the same thing the topbar button has always done. */}
      <Group
        id="set-g-appearance"
        title="Appearance"
        lede={
          'The one thing on this page you change here. Which theme you picked is remembered in this '
          + 'browser only; a theme you write is a file on the box, and every browser that reaches it '
          + 'sees the same one.'
        }
      >
        <Theme />
        <MakeATheme />
        <Reading />
      </Group>

      <Group
        id="set-g-stores"
        title="Where these are kept"
        lede={
          'Three stores hold everything above, and the difference between them is the only one that '
          + 'matters in practice: whether a change follows you to another device.'
        }
      >
        <Stores />
        <NoStore />
      </Group>
    </div>
  );
}

// A named group of panels.
//
// The heading is an <h2> and every panel heading inside it is an <h3>, so the
// document outline is the same grouping the eye is given. The alternative - a
// styled div that only LOOKS like a heading - is the version that goes stale:
// it survives a refactor that moves a panel into the wrong group, because
// nothing but the eye was ever asserting where the panel belonged.
function Group({ id, title, lede, children }: {
  id: string;
  title: string;
  lede: string;
  children: React.ReactNode;
}) {
  return (
    <section className="set-group" aria-labelledby={id}>
      <header className="set-group-h">
        <h2 id={id}>{title}</h2>
        <p className="set-group-lede">{lede}</p>
      </header>
      {children}
    </section>
  );
}

/**
 * How big a document is, and how big the panels around it are (#156).
 *
 * TWO numbers, because they answer different questions. Raising the document
 * widens the reading column (`--read-measure` is `100%`, but the type inside it
 * grows) and does nothing to the rails; raising the panels makes the index and
 * the outline legible without reflowing a word of prose. One control would tie
 * them together and neither would land where anyone wanted it.
 *
 * IT IS HERE FOR THE SAME REASON THE THEME IS, and it is the same kind of thing:
 * one key in localStorage in this browser, no server, no write path, no audit
 * trail. The read-only rule this page states is about a SERVER-side preference
 * store, which is still #157's open question - not about the browser remembering
 * how big you like your type. The Stores table below says out loud that it does
 * not follow you to another device.
 *
 * The sample is not decoration. These are two numbers with no unit anybody
 * thinks in, and "12.5px" means nothing until you have seen a row at it - so the
 * control shows the thing it changes, at the size it will be.
 */
function Reading() {
  const [reading, setReading] = useReading();
  const rows: { key: keyof Reading; label: string; hint: string }[] = [
    { key: 'doc', label: 'Document text', hint: 'The rendered page in Files - prose, tables and code.' },
    { key: 'ui', label: 'Panel text', hint: 'The document index on the left and the outline on the right.' },
  ];

  return (
    <section className="panel">
      <h3>Reading size</h3>
      <p className="set-lede">
        The type in Files. A document is not a dashboard, and the size that suits a
        14-inch laptop is not the one that suits a 27-inch monitor - so this is a
        setting rather than a number somebody picked once.
      </p>
      <div className="set-reading">
        {rows.map(({ key, label, hint }) => {
          const v = reading[key];
          const { min, max } = READING_LIMITS[key];
          const step = READING_STEP[key];
          return (
            <div className="set-read-row" key={key}>
              <div className="set-read-lbl">
                <span className="set-read-name">{label}</span>
                <span className="set-read-hint">{hint}</span>
              </div>
              <div className="set-read-ctl" role="group" aria-label={label}>
                <button
                  type="button"
                  className="icon-btn set-read-btn"
                  onClick={() => setReading({ [key]: v - step })}
                  disabled={v <= min}
                  aria-label={`Smaller ${label.toLowerCase()}`}
                >
                  <Minus size={14} />
                </button>
                {/* `aria-live` so a screen reader hears the new size, which is
                    the only feedback a non-visual user gets from a control whose
                    whole effect is visual. */}
                <span className="set-read-v tnum" aria-live="polite">{v}px</span>
                <button
                  type="button"
                  className="icon-btn set-read-btn"
                  onClick={() => setReading({ [key]: v + step })}
                  disabled={v >= max}
                  aria-label={`Larger ${label.toLowerCase()}`}
                >
                  <Plus size={14} />
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setReading({ [key]: READING_DEFAULT[key] })}
                  disabled={v === READING_DEFAULT[key]}
                >
                  Reset
                </button>
              </div>
              <p className="set-read-sample" style={{ fontSize: `${v}px` }}>
                {key === 'doc'
                  ? 'The quick brown fox jumps over the lazy dog.'
                  : 'Tailnet troubleshooting'}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Theme() {
  const { selection, theme, themes, setSelection } = useTheme();
  const custom = themes.filter((t) => t.user).length;

  // System first, then the themes. It is the only entry that is not a palette -
  // it is a rule for picking one - so it gets said in words rather than given a
  // swatch row that would imply it had colours of its own.
  return (
    <section className="panel">
      <h3 className="panel-h">Theme</h3>
      <div className="panel-b">
        {/* The `yours` tag is only explained when there is one on screen to
            explain. A legend for a mark that is nowhere in the list below reads
            as a feature the reader has failed to find. */}
        <p className="set-lede">
          The topbar button still toggles dark, light and system in one tap; the full list is here.
          {custom > 0 && (
            <> A theme tagged <span className="theme-tag">yours</span> came from a file on the box
            rather than from the app.</>
          )}
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
              {/* An anchor INSIDE the card, and the card is a button - so the
                  click has to be stopped from also selecting the theme. Nested
                  interactive elements are usually a smell; here the alternative
                  was a second row of controls under every card, which is worse
                  for the seven themes that will never have one. */}
              {t.user && (
                <Link
                  to={`/settings/theme/${t.id}`}
                  className="theme-edit"
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`Edit ${t.name}`}
                >
                  <Pencil size={12} aria-hidden="true" /> Edit
                </Link>
              )}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

// Making a theme is not choosing one, and it used to be asked to look like it:
// an eighth card at the end of a list of palettes, competing with the row the
// reader was actually scanning, plus a paragraph about a directory wedged above
// the picker. Both routes now live here, side by side, because the point they
// make together is that they PRODUCE THE SAME THING - one .css file in one
// directory. The editor is not a lighter-weight alternative to writing the file;
// it is a preview attached to the same output.
function MakeATheme() {
  const { themes } = useTheme();
  const custom = themes.filter((t) => t.user).length;

  return (
    <section className="panel">
      <h3 className="panel-h">Make your own</h3>
      <div className="panel-b">
        <div className="make-grid">
          <Link to="/settings/theme/new" className="make">
            <p className="make-h"><Plus size={15} aria-hidden="true" /> In the theme editor</p>
            <p className="make-p">
              Starts from the theme you are using now and applies every change to the whole page as you
              type, so you are judging the real thing rather than a swatch in a corner. The palette rules
              run live and warn; they never refuse. Saving writes the file, which needs the{' '}
              <span className="mono">editor</span> role.
            </p>
          </Link>

          {/* Deliberately a HOST path rather than a container one - the person
              who needs this sentence is standing in the repo. */}
          <div className="make">
            <p className="make-h"><Code2 size={15} aria-hidden="true" /> Or write the file</p>
            <p className="make-p">
              Drop a <code className="mono">.css</code> file into{' '}
              <code className="mono">{THEME_DIR_HOST}</code> on the box and reload. One file is the whole
              theme and it survives a rebuild; <code className="mono">README.md</code> in that directory
              documents the format, and copying an existing theme is the quickest start.
            </p>
          </div>
        </div>

        <p className="set-note make-count">
          {custom === 0
            ? 'Nothing is in that directory yet, so every theme in the list above came from the app.'
            : custom === 1
              ? 'One theme in the list above came from there.'
              : `${custom} of the themes in the list above came from there.`}
        </p>
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
      <h3 className="panel-h">You are not signed in</h3>
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
        <h3 className="panel-h">Your account</h3>
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
        <h3 className="panel-h">
          What you may do
          {/* Not "3 of 4". One of the four is granted to nobody, so a
              denominator would state a total that cannot be reached. */}
          <span className="sub">{me.roles.length} held</span>
        </h3>
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
          {/* A TOKEN CAN BE OUT OF DATE WITH RESPECT TO THE ACCOUNT, and nothing
              here could tell. Realm roles arrive as a flat `groups` claim from a
              protocol mapper, which means they are stamped into the token AT
              SIGN-IN. Grant yourself a role afterwards and this page keeps
              saying "not held" - correctly, about the token - while Keycloak
              has already granted it. The 403 that follows is then unexplainable
              from the one screen that exists to explain it.
              Observed on this box: `operator` was granted by keycloak-init and
              the live session, started earlier, did not carry it. */}
          <p className="set-note">
            This describes the token this browser is carrying, which was issued when you
            signed in. A role granted to your account after that is not in it - sign out
            and back in to pick one up.
          </p>
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
      <h3 className="panel-h">Where this session comes from</h3>
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
            <span className="mono">sso-viewer</span>, <span className="mono">sso-editor</span> and{' '}
            <span className="mono">sso-operator</span>, forwardAuth middlewares at the edge
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

// `elsewhere` is the question a reader actually arrives with, and until it was
// written down the page made them infer it from the store's name: "localStorage"
// only answers "does this follow me to my phone" if you already know what
// localStorage is. So each store answers it in a sentence, in the same slot,
// and the three answers differ - which is the whole reason the three stores are
// worth telling apart at all.
const STORES = [
  {
    what: 'Which theme you picked, and the widths of the panes in Files',
    where: 'This browser',
    store: 'localStorage',
    elsewhere: 'Not there. Another browser, another device or a cleared profile starts from the default.',
    why: 'Per browser is the right home for these, not a limitation. A pane width is a fact about the '
      + 'screen you are sitting at; carrying it to a phone would be the bug. They are changed where '
      + 'they are used - the theme button in the topbar, the panes themselves - rather than here.',
  },
  {
    what: 'How big the type in Files is - the document, and the panels beside it',
    where: 'This browser',
    store: 'localStorage',
    elsewhere: 'Not there. Another browser, another device or a cleared profile reads at the default '
      + 'sizes, which are the ones this box shipped with.',
    why: 'The right size for a page of prose depends on the screen you are sitting at, not on who you '
      + 'are - a 14-inch laptop and a 27-inch monitor want different numbers from the same person. '
      + 'That is the same test the theme and the pane widths pass, so it is kept in the same place '
      + 'and admitted to in the same sentence. If a per-user store is ever built, this is one of the '
      + 'first things that would move into it.',
  },
  {
    what: 'Which service groups you have collapsed',
    where: 'This browser',
    store: 'localStorage',
    elsewhere: 'Not there. Another browser starts with every group open, which is also what a browser '
      + 'that has never been told otherwise shows.',
    why: 'Only the groups you CLOSED are written down, so a group nobody has touched is open because '
      + 'it is absent rather than because a default was recorded - the Services page looks exactly as '
      + 'it always has until you collapse something. They are filed under what a system IS, not under '
      + 'the name it is displayed by, so renaming a project or setting dev.portal.group does not make '
      + 'the page forget. Groups the box no longer has are dropped rather than kept forever.',
  },
  {
    what: 'A theme you wrote yourself',
    where: 'The box, as a file',
    store: THEME_DIR_HOST,
    elsewhere: 'Offered everywhere. It is one file on the box, so every browser that reaches it lists '
      + 'the theme - though each of them still has to pick it.',
    why: 'The row above is the CHOICE - one key naming a theme, per browser. The theme itself is a '
      + '.css file on disk, shared by every browser that reaches this box, and it outlives that '
      + 'choice: clearing this browser forgets which theme you picked, not the file you wrote. It is '
      + 'also the only thing on this page you change with an editor rather than with the page.',
  },
  {
    what: 'Your username, email, subject id and roles',
    where: 'Your account',
    store: 'Keycloak',
    elsewhere: 'The same. It is the account, not the browser - it follows you wherever you sign in.',
    why: 'Per user, and read-only here. They arrive with the session and are changed in the realm. '
      + 'This page has no way to write them, which is the point.',
  },
];

function Stores() {
  return (
    <section className="panel">
      <h3 className="panel-h">What is stored where</h3>
      <div className="panel-b">
        <ul className="stores">
          {STORES.map((s) => (
            <li className="store" key={s.what}>
              <p className="store-what">{s.what}</p>
              <p className="store-where">
                {s.where}
                <span className="mono store-store">{s.store}</span>
              </p>
              <p className="store-follow">
                <span className="store-follow-k">On another device</span>
                {s.elsewhere}
              </p>
              <p className="store-why">{s.why}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// The fourth store used to be a fourth row in the list above, which quietly
// claimed it was the same KIND of thing as the other three. It is not: the other
// three are places, and this is a decision. Given its own panel it can be read
// as one - and the panel is also the page's answer to the reasonable question of
// why nothing here has a Save button.
function NoStore() {
  return (
    <section className="panel">
      <h3 className="panel-h">And what is not stored at all</h3>
      <div className="panel-b">
        <p className="set-lede">
          A default root, a default landing page, a list of favourites. None of these is kept anywhere,
          and none of them is on the page wearing a &ldquo;coming soon&rdquo; label.
        </p>
        <p className="store-why">
          A preference store is a write path, and a write path needs a threat model, an audit trail and a
          boundary before it needs a form - <span className="mono">docs/plans/control-and-settings.md</span>{' '}
          §6b. That is worth paying for the day somebody asks to keep a preference, and nobody has. Until
          then a greyed-out control would be a promise this page has no way to keep, which is why there
          are none on it.
        </p>
      </div>
    </section>
  );
}
