// Profile & session - who the session says you are, and what that lets you do.
//
// Moved from the single-page Settings.tsx with its reasoning intact: all of this
// arrives with the session (oauth2-proxy's /oauth2/userinfo), follows you to every
// browser you sign in on, and is changed in the realm rather than here. The role
// list describes a TOKEN; the edge decides, and a role missing here has never
// stopped a request - it only explains the 403 in advance.

import { Ban, Circle, CircleCheck, LogIn, LogOut } from 'lucide-react';
import { ROLES, ROLE_MEANING, signInHref, signOutHref, type Me, type Role } from '../../lib/me';
import { useMe } from '../../components/UserMenu';
import { SettingBlock } from '../../components/settings/SettingBlock';
import { Fact, Loading } from '../../components/settings/bits';
import { buttonClass } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';

export function ProfileSettings() {
  const { me, loading } = useMe();
  return (
    <>
      <SettingBlock id="account" badge="from the session">
        {loading ? <Loading rows={3} /> : me ? <Account me={me} /> : <SignedOut />}
      </SettingBlock>
      <SettingBlock id="roles" badge="from the session">
        {loading ? <Loading rows={4} /> : <Roles me={me} />}
      </SettingBlock>
      <SettingBlock id="session">
        <Session signedIn={!!me} />
      </SettingBlock>
    </>
  );
}

function SignedOut() {
  return (
    <div className="set-empty">
      <p>
        Nothing here knows who you are yet. Signing in returns you to this page, which will then say which of the four
        roles your account holds and what each one permits.
      </p>
      <a className={buttonClass({ variant: 'primary', size: 'sm' })} href={signInHref()}>
        <Icon icon={LogIn} size="sm" /> Sign in
      </a>
    </div>
  );
}

function Account({ me }: { me: Me }) {
  // Everything the token carries that is not one of the four realm roles is
  // Keycloak's own bookkeeping - noise most days, exactly what you want on the day
  // a token looks wrong. Shown quietly, and never as a role.
  const other = me.groups.filter((g) => !(ROLES as readonly string[]).includes(g));
  return (
    <div className="kv-list">
      <Fact label="Username">{me.preferredUsername}</Fact>
      <Fact label="Email">{me.email || <span className="dim">none on the token</span>}</Fact>
      <Fact label="Subject">
        <span className="mono set-sub">{me.user}</span>
        <span className="set-note">The durable identifier. The username and the email can change; this cannot.</span>
      </Fact>
      {other.length > 0 && (
        <Fact label="Other groups">
          <span className="mono set-sub">{other.join(' · ')}</span>
          <span className="set-note">Keycloak&rsquo;s own bookkeeping. None of these grants anything here.</span>
        </Fact>
      )}
    </div>
  );
}

function Roles({ me }: { me: Me | null }) {
  return (
    <>
      <ul className="roles">
        {ROLES.map((r) => <RoleRow key={r} role={r} held={!!me?.roles.includes(r)} />)}
      </ul>
      <p className="set-note">
        {me
          ? `${me.roles.length} held. This describes the token this browser carries, issued when you signed in - a role granted to your account after that is not in it; sign out and back in to pick it up.`
          : 'Signed out, so no token and no roles. The list above is what the realm defines.'}
      </p>
    </>
  );
}

function RoleRow({ role, held }: { role: Role; held: boolean }) {
  // `shell` is granted to nobody on purpose, so a plain "not held" beside
  // `operator` would invite the wrong question. A condition, not a constant: if
  // it is ever granted, this must say so.
  const ungrantable = role === 'shell' && !held;
  const state = held ? 'Held' : ungrantable ? 'Granted to nobody' : 'Not held';
  const Mark = held ? CircleCheck : ungrantable ? Ban : Circle;
  return (
    <li className="role" data-held={held ? 'yes' : 'no'}>
      <Icon icon={Mark} size="md" className="role-mark" />
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

function Session({ signedIn }: { signedIn: boolean }) {
  // Built from the host being browsed: the box is reached by its tailnet IP and
  // the SPA has no other way to know it. /realms/devbox/account answers over
  // plain HTTP (checked); password, sessions and devices are changed there.
  const kc = `http://${location.hostname}:8090`;
  return (
    <>
      <div className="kv-list">
        <Fact label="Issued by">
          Keycloak, realm <span className="mono">devbox</span>, at <span className="mono">{kc}</span>
          <span className="set-note">
            <a className="link" href={`${kc}/realms/devbox/account`}>Account console</a>
            {' '}- your password, your sessions and your devices are changed there, not here.
          </span>
        </Fact>
        <Fact label="Carried by">
          oauth2-proxy, asked by Traefik on every gated request
          <span className="set-note">
            A host-only cookie. Every service on this box is a different port on one host, so a session on the box&rsquo;s
            address is not a session on localhost.
          </span>
        </Fact>
        <Fact label="Enforced by">
          <span className="mono">sso-viewer</span>, <span className="mono">sso-editor</span> and{' '}
          <span className="mono">sso-operator</span>, forwardAuth middlewares at the edge
          <span className="set-note">Not by this page. The refusal, when it comes, is decided before a request reaches an application.</span>
        </Fact>
      </div>
      <div className="set-actions">
        {signedIn ? (
          <a className={buttonClass({ variant: 'ghost', size: 'sm' })} href={signOutHref()}>
            <Icon icon={LogOut} size="sm" /> Sign out
          </a>
        ) : (
          <a className={buttonClass({ variant: 'ghost', size: 'sm' })} href={signInHref()}>
            <Icon icon={LogIn} size="sm" /> Sign in
          </a>
        )}
        <span className="set-note">Signing out ends the Bothy session in this browser and returns you to the Overview.</span>
      </div>
    </>
  );
}
