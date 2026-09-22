// Credentials - where every secret on the box lives, and how to rotate it.
// NEVER A VALUE: bothy-ops serves a host-generated metadata inventory
// (apps/bothy-ops/inventory.py), re-filtered to an allow-list, behind operator.
// The only facts derived from a value are "is it set" and "is it still a public
// placeholder from .env.example".
//
// Rotation is a command, shown and copyable, not a button. Every rotation on this
// box restarts or re-issues something, and several sign people out; a shell is
// where that belongs until a write path is designed for it.

import { AlertTriangle } from 'lucide-react';
import { SettingBlock } from '../../components/settings/SettingBlock';
import { Loading, Prose, Refusal, When, useLoad } from '../../components/settings/bits';
import { fetchCredentials, type CredentialsResult, type EnvKey } from '../../lib/admin';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';

export function CredentialsSettings() {
  const { data, error, loading, reload } = useLoad((signal) => fetchCredentials(signal));
  const body = (render: (d: CredentialsResult) => React.ReactNode) => (loading ? <Loading rows={5} /> : error ? (
    <>
      <Refusal error={error} needs="operator" what="the credential inventory" />
      <Button variant="ghost" size="sm" onClick={reload}>Retry</Button>
    </>
  ) : data ? render(data) : null);

  return (
    <>
      {data && <Freshness d={data} />}
      <SettingBlock id="env-keys" badge="names only · operator">{body((d) => <EnvKeys d={d} />)}</SettingBlock>
      <SettingBlock id="credential-files" badge="metadata only · operator">{body((d) => <Files d={d} />)}</SettingBlock>
      <SettingBlock id="keycloak-clients" badge="metadata only · operator">{body((d) => <Clients d={d} />)}</SettingBlock>
    </>
  );
}

function Freshness({ d }: { d: CredentialsResult }) {
  return (
    <p className={`set-fresh ${d.stale ? 'is-stale' : ''}`} role="status">
      {d.stale && <Icon icon={AlertTriangle} size="sm" />}
      Inventory written on the host <When iso={d.generatedAt} />
      {d.stale ? ' - older than fifteen minutes; the bothy-inventory timer may not be running. ' : '. '}
      Refresh it with <span className="mono">just admin-inventory</span>.
    </p>
  );
}

function keyState(k: EnvKey): { word: string; warn: boolean } {
  if (!k.set) return { word: 'not set', warn: k.credential };
  if (k.placeholder) return { word: 'placeholder', warn: true };
  return { word: 'set', warn: false };
}

function EnvKeys({ d }: { d: CredentialsResult }) {
  const creds = d.env.keys.filter((k) => k.credential);
  const other = d.env.keys.filter((k) => !k.credential);
  const modeOff = d.env.mode && d.env.expectMode && d.env.mode !== d.env.expectMode;
  return (
    <>
      <p className="set-lede">
        <span className="mono">{d.env.path}</span> · mode <span className={`mono ${modeOff ? 'set-warn' : ''}`}>{d.env.mode ?? '?'}</span>
        {modeOff && ` (expected ${d.env.expectMode})`} · changed <When iso={d.env.changed} />.
        {' '}A change date is the FILE’s: .env does not record when one key changed.
      </p>
      <div className="tbl-wrap scroll-shade set-tbl">
        <table className="tbl as-cards set-creds">
          <thead>
            <tr><th scope="col">Key</th><th scope="col">State</th><th scope="col">For, and read by</th><th scope="col">Rotate</th></tr>
          </thead>
          <tbody>
            {creds.map((k) => {
              const st = keyState(k);
              const unused = k.usedBy.length === 0;
              return (
                <tr key={k.key}>
                  <td className="mono set-key">{k.key}</td>
                  <td data-label="State">
                    <span className={`set-state ${st.warn ? 'set-warn' : ''}`}>
                      {st.warn && <Icon icon={AlertTriangle} size="sm" />}{st.word}
                    </span>
                  </td>
                  <td data-label="For">
                    {k.purpose ?? (unused ? <span className="dim">Nothing in the repository reads this key - a leftover.</span> : <span className="dim">No description.</span>)}
                    {!unused && <span className="set-cell-sub mono">{k.usedBy.slice(0, 4).join(' · ')}{k.usedBy.length > 4 ? ` +${k.usedBy.length - 4}` : ''}</span>}
                  </td>
                  <td className="set-rotate" data-label="Rotate">{k.rotate ? <Prose text={k.rotate} /> : <span className="dim">{unused ? 'Remove it from .env.' : 'No recorded procedure.'}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {other.length > 0 && (
        <p className="set-note set-tbl-note">
          Also in .env, not credentials: <span className="mono">{other.map((k) => k.key).join(' · ')}</span>
        </p>
      )}
    </>
  );
}

function Files({ d }: { d: CredentialsResult }) {
  return (
    <div className="tbl-wrap scroll-shade set-tbl">
      <table className="tbl as-cards set-creds">
        <thead>
          <tr><th scope="col">File</th><th scope="col">Mode</th><th scope="col">Changed</th><th scope="col">For, and read by</th><th scope="col">Rotate</th></tr>
        </thead>
        <tbody>
          {d.files.filter((f) => f.id !== 'env').map((f) => {
            const off = f.present && f.actualMode && f.actualMode !== f.expectMode;
            return (
              <tr key={f.id}>
                <td className="mono set-key">{f.path}</td>
                <td data-label="Mode">
                  {f.present === false ? <span className="dim">absent</span>
                    : f.present === null ? <span className="dim">unreadable</span>
                      : <span className={`mono ${off ? 'set-warn' : ''}`}>{off && <Icon icon={AlertTriangle} size="sm" />}{f.actualMode}</span>}
                  {off && <span className="set-cell-sub">expected {f.expectMode}</span>}
                </td>
                <td data-label="Changed">{f.present ? <When iso={f.changed} /> : <span className="dim">-</span>}</td>
                <td data-label="For">{f.purpose}<span className="set-cell-sub mono">{f.usedBy.join(' · ')}</span></td>
                <td className="set-rotate" data-label="Rotate"><Prose text={f.rotate} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Clients({ d }: { d: CredentialsResult }) {
  return (
    <>
      <div className="tbl-wrap scroll-shade set-tbl">
        <table className="tbl as-cards set-creds">
          <thead>
            <tr><th scope="col">Client</th><th scope="col">Secret kept in</th><th scope="col">Changed</th><th scope="col">For</th></tr>
          </thead>
          <tbody>
            {d.clients.map((c) => (
              <tr key={c.id}>
                <td className="mono set-key">{c.id}<span className="set-cell-sub">realm {c.realm}</span></td>
                <td className="mono" data-label="Secret kept in">{c.set ? c.where : <span className="dim">{c.where} - not present</span>}</td>
                <td data-label="Changed">{c.set ? <When iso={c.changed} /> : <span className="dim">-</span>}</td>
                <td data-label="For">{c.purpose}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="set-note set-tbl-note">
        The change date is the file holding the secret, not Keycloak’s own record. Reading Keycloak’s would need{' '}
        <span className="mono">view-clients</span>, which can read every client secret in the realm - the admin client
        is deliberately not given it.
      </p>
    </>
  );
}
