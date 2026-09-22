// Users & roles - every account in realm devbox, read through bothy-ops'
// GET /-/api/admin/users (operator), which asks Keycloak with a client that can
// only view users. Nothing on this page changes an account: granting a role or
// resetting a password is done in Keycloak's console, linked below, until a write
// path exists with its own confirmation, audit line and manage-users scope.

import { Ban, Circle, CircleCheck } from 'lucide-react';
import { SettingBlock } from '../../components/settings/SettingBlock';
import { Loading, Refusal, When, useLoad } from '../../components/settings/bits';
import { fetchUsers, ROLES, type AdminUser } from '../../lib/admin';
import { ROLE_MEANING, type Role } from '../../lib/me';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';

export function UsersSettings() {
  const { data, error, loading, reload } = useLoad((signal) => fetchUsers(signal));
  const kc = `http://${location.hostname}:8090`;
  return (
    <>
      <SettingBlock id="user-list" badge="read-only · operator">
        {loading ? <Loading rows={4} /> : error ? (
          <>
            <Refusal error={error} needs="operator" what="the users" />
            <Button variant="ghost" size="sm" onClick={reload}>Retry</Button>
          </>
        ) : data && (
          <>
            <UserTable users={data.users} />
            <p className="set-note set-tbl-note">
              {data.users.length} account{data.users.length === 1 ? '' : 's'} in realm <span className="mono">{data.realm}</span>,
              read <When iso={data.fetchedAt} /> by client <span className="mono">{data.client}</span>.
              {data.truncated && ' Only the first 200 are shown.'}
              {' '}Service accounts are not listed - Keycloak keeps them out of the user list.
            </p>
          </>
        )}
      </SettingBlock>

      <SettingBlock id="role-ladder" badge="read-only">
        <ul className="roles">
          {ROLES.map((r) => (
            <li className="role" key={r} data-held="no">
              <span className="role-id mono set-role-id">{r}</span>
              <div className="role-text"><p className="role-why">{ROLE_MEANING[r as Role]}</p></div>
            </li>
          ))}
        </ul>
        <p className="set-note">
          Flat and non-composite on purpose: holding one never implies another, so <span className="mono">shell</span>{' '}
          cannot arrive by accident. A role is checked at the edge on each request, against the token issued at sign-in.
        </p>
      </SettingBlock>

      <SettingBlock id="user-changes" badge="read-only">
        <div className="kv-list">
          <div className="kv"><div className="kv-k">Accounts and roles</div><div className="kv-v">
            In the Keycloak admin console, realm <span className="mono">devbox</span> -{' '}
            <a className="link" href={`${kc}/admin/master/console/#/devbox/users`}>open Users</a>. Sign in as the
            master-realm admin.
          </div></div>
          <div className="kv"><div className="kv-k">Your own password</div><div className="kv-v">
            <a className="link" href={`${kc}/realms/devbox/account`}>The account console</a> - any signed-in user.
          </div></div>
          <div className="kv"><div className="kv-k">Roles re-asserted</div><div className="kv-v">
            <span className="mono">just up-auth</span> re-grants <span className="mono">viewer editor operator</span> to the
            seed user on every run, and never <span className="mono">shell</span>.
          </div></div>
          <div className="kv"><div className="kv-k">Why not here</div><div className="kv-v">
            A role grant from a browser is a write to the thing that decides every other permission. It needs its own
            operator route, a type-the-name confirmation, an audit line and a client with{' '}
            <span className="mono">manage-users</span> - none of which exists yet.
          </div></div>
        </div>
      </SettingBlock>
    </>
  );
}

function RoleCells({ u }: { u: AdminUser }) {
  return (
    <>
      {ROLES.map((r) => {
        const held = u.roles.includes(r);
        const nobody = r === 'shell' && !held;
        const Mark = held ? CircleCheck : nobody ? Ban : Circle;
        return (
          <td key={r} className="set-role-cell" data-held={held ? 'yes' : 'no'}>
            <Icon icon={Mark} size="md" />
            <span className="sr-only">{held ? 'held' : 'not held'}</span>
          </td>
        );
      })}
    </>
  );
}

function UserTable({ users }: { users: AdminUser[] }) {
  if (!users.length) return <p className="set-empty">The realm has no users. <span className="mono">just up-auth</span> seeds one.</p>;
  return (
    <div className="tbl-wrap scroll-shade set-tbl">
      <table className="tbl set-users">
        <thead>
          <tr>
            <th scope="col">Account</th>
            {ROLES.map((r) => <th scope="col" key={r} className="set-role-h mono">{r}</th>)}
            <th scope="col">Password set</th>
            <th scope="col">Sessions</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>
                <b>{u.username}</b>
                <span className="set-cell-sub">{u.email ?? 'no email'}{u.emailVerified ? '' : u.email ? ' · unverified' : ''}</span>
              </td>
              <RoleCells u={u} />
              <td>
                {u.credentials.includes('password') ? <When iso={u.passwordSetAt} empty="unknown" /> : <span className="dim">no password</span>}
                <span className="set-cell-sub">{u.otp ? 'with a second factor' : 'no second factor'}</span>
              </td>
              <td className="tnum">
                {u.sessions}
                {u.lastSeenAt && <span className="set-cell-sub">last <When iso={u.lastSeenAt} /></span>}
              </td>
              <td>
                {u.enabled ? 'Enabled' : <b>Disabled</b>}
                {u.requiredActions.length > 0 && (
                  <span className="set-cell-sub">must {u.requiredActions.map((a) => a.toLowerCase().replace(/_/g, ' ')).join(', ')}</span>
                )}
                {u.otherRoles.length > 0 && <span className="set-cell-sub mono">{u.otherRoles.join(' · ')}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
