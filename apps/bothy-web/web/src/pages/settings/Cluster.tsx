// Cluster - what Bothy may do to Kubernetes, and with which identity.
//
// The scope and the verbs are the UI's mirror of bothy-ops' catalog (lib/
// kube-actions.ts, which apps/bothy-ops/checks/wiring.py holds equal to
// catalog.toml), so this page cannot claim a verb the service does not have. The
// token's age comes from the credential inventory when the reader holds
// operator; otherwise the page says which command shows it.

import { StatusIcon } from '../../lib/icons';
import { usePortal } from '../../lib/data';
import { KUBE_CATALOG, KUBE_NAMESPACES, SCALE_MAX } from '../../lib/kube-actions';
import { fetchCredentials } from '../../lib/admin';
import { SettingBlock } from '../../components/settings/SettingBlock';
import { Cmd, Loading, When, useLoad } from '../../components/settings/bits';
import { statusOf } from '../../lib/http';

export function ClusterSettings() {
  return (
    <>
      <SettingBlock id="cluster-scope" badge="read-only"><Scope /></SettingBlock>
      <SettingBlock id="cluster-identity" badge="read-only"><Identity /></SettingBlock>
      <SettingBlock id="headlamp" badge="read-only"><Headlamp /></SettingBlock>
    </>
  );
}

function Scope() {
  return (
    <>
      <p className="set-lede">
        Two namespaces, as a literal list in the service - not a pattern, not a label selector:{' '}
        {KUBE_NAMESPACES.map((n, i) => <span key={n}>{i > 0 && ' and '}<span className="mono set-pill">{n}</span></span>)}.
        Anything else is refused before a request reaches the apiserver.
      </p>
      <div className="tbl-wrap set-tbl">
        <table className="tbl">
          <thead>
            <tr><th scope="col">Action</th><th scope="col">Role</th><th scope="col">Confirmation</th><th scope="col">What it does</th></tr>
          </thead>
          <tbody>
            {KUBE_CATALOG.map((a) => (
              <tr key={a.id}>
                <td><b>{a.title}</b><span className="set-cell-sub mono">{a.id}</span></td>
                <td className="mono">{a.role}</td>
                <td>{a.confirm === 'type-name' ? 'type the name' : a.confirm === 'click' ? 'one click' : 'none'}</td>
                <td>{a.meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="set-note set-tbl-note">
        Scale is capped at {SCALE_MAX} replicas. There is no exec, no port-forward and no Secret read, and the
        ServiceAccount could not do them if the service tried.
      </p>
    </>
  );
}

function Identity() {
  const { data, error, loading } = useLoad((signal) => fetchCredentials(signal));
  const token = data?.files.find((f) => f.id === 'kube-token');
  return (
    <>
      <div className="kv-list">
        <div className="kv"><div className="kv-k">Account</div><div className="kv-v">
          <span className="mono">system:serviceaccount:bothy:bothy-kube</span>
          <span className="set-note">One Role per namespace in <span className="mono">k8s/rbac/bothy-kube.yaml</span>; no ClusterRole.</span>
        </div></div>
        <div className="kv"><div className="kv-k">Token</div><div className="kv-v">
          {loading ? <Loading rows={1} /> : token ? (
            token.present
              ? <>issued <When iso={token.changed} />, mode <span className="mono">{token.actualMode}</span>, at <span className="mono">{token.path}</span></>
              : <>not issued on this box - kube actions answer 503 until it is.</>
          ) : (
            <span className="dim">
              {statusOf(error) === 403 || statusOf(error) === 401
                ? 'Its age is in the credential inventory, which needs operator.'
                : 'The credential inventory did not answer, so its age is unknown here.'}
            </span>
          )}
          <span className="set-note">A long-lived Secret token on purpose: an unattended box must not expire silently.</span>
        </div></div>
        <div className="kv"><div className="kv-k">What it can do</div><div className="kv-v">
          <Cmd>just kube-token</Cmd>
          <span className="set-note">Applies the RBAC, rewrites the token if absent, and prints the can-i table; it exits non-zero if any row is unexpected.</span>
        </div></div>
        <div className="kv"><div className="kv-k">Rotate or revoke</div><div className="kv-v">
          <Cmd>just kube-token --rotate</Cmd> <Cmd>just kube-token --revoke</Cmd>
          <span className="set-note">Re-read per request, so a rotation needs no restart.</span>
        </div></div>
      </div>
    </>
  );
}

function Headlamp() {
  const { data } = usePortal();
  const find = (name: string) => data.nodes.find((n) => n.container?.name === name);
  const proxy = find('oauth2-proxy-headlamp');
  const app = find('headlamp');
  const minikube = find('thales-scc');
  const url = `http://${location.hostname}:8110`;
  const row = (label: string, n: ReturnType<typeof find>, absent: string) => (
    <div className="kv"><div className="kv-k">{label}</div><div className="kv-v">
      {n ? <StatusIcon status={n.status} showLabel /> : <span className="dim">{absent}</span>}
      {n?.container?.image && <span className="set-note mono">{n.container.image}</span>}
    </div></div>
  );
  return (
    <>
      <div className="kv-list">
        {row('Cluster', minikube, 'no container named thales-scc - the cluster is not running')}
        {row('Headlamp', app, 'not running')}
        {row('Its login', proxy, 'not running')}
        <div className="kv"><div className="kv-k">Open</div><div className="kv-v">
          <a className="link mono" href={url} target="_blank" rel="noopener noreferrer">{url}</a>
          <span className="set-note">Keycloak login, role viewer. Read-only: the identity behind it is bound to the built-in view role.</span>
        </div></div>
        <div className="kv"><div className="kv-k">Start it</div><div className="kv-v">
          <Cmd>just up-headlamp</Cmd>
          <span className="set-note">Only while the cluster runs; it joins minikube’s network.</span>
        </div></div>
      </div>
      {data.at === 0 && <p className="set-note">Waiting for the first poll of the box.</p>}
    </>
  );
}
