// Backups - what scripts/backup.sh keeps, how recent and how big, from the host
// inventory (names, times and sizes only - a backup of .env is every password in
// plaintext, so ~/backups is never mounted into a container).

import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { filesHref } from '../files/routes';
import { SettingBlock } from '../../components/settings/SettingBlock';
import { Cmd, Loading, Refusal, When, fmtBytes, useLoad } from '../../components/settings/bits';
import { fetchBackups, type BackupsResult } from '../../lib/admin';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';

const DAY = 86_400_000;

export function BackupsSettings() {
  const { data, error, loading, reload } = useLoad((signal) => fetchBackups(signal));
  const fail = (
    <>
      <Refusal error={error} needs="operator" what="the backup inventory" />
      <Button variant="ghost" size="sm" onClick={reload}>Retry</Button>
    </>
  );
  return (
    <>
      <SettingBlock id="backup-sets" badge="metadata only · operator">
        {loading ? <Loading rows={4} /> : error ? fail : data && <Sets d={data} />}
      </SettingBlock>
      <SettingBlock id="backup-schedule" badge="read-only">
        {loading ? <Loading rows={2} /> : error ? <Schedule d={null} /> : <Schedule d={data} />}
      </SettingBlock>
    </>
  );
}

function Sets({ d }: { d: BackupsResult }) {
  if (d.present === false) {
    return <p className="set-empty">There is no <span className="mono">{d.root}</span> yet - no backup has ever run on this box.</p>;
  }
  const managed = d.sets.filter((s) => s.managed);
  const other = d.sets.filter((s) => !s.managed);
  const total = d.sets.reduce((n, s) => n + (s.bytes ?? 0), 0);
  // Sets that keep fewer copies than the default (the time-series stores), named.
  const fewer = managed.filter((s) => s.keep != null && d.keep != null && s.keep < d.keep);
  const row = (s: BackupsResult['sets'][number]) => {
    const age = s.newest?.at ? Date.now() - Date.parse(s.newest.at) : null;
    const old = s.managed && age !== null && age > 2 * DAY;
    return (
      <tr key={s.name}>
        <td><b className="mono">{s.name}</b>{s.what && <span className="set-cell-sub">{s.what}</span>}</td>
        <td>
          {s.newest ? (
            <span className={old ? 'set-warn' : ''}>
              {old && <Icon icon={AlertTriangle} size="sm" />}<When iso={s.newest.at} />
            </span>
          ) : <span className="dim">empty</span>}
          {s.newest && <span className="set-cell-sub mono">{s.newest.name} · {fmtBytes(s.newest.bytes)}</span>}
        </td>
        <td className="num tnum">{s.readable === false ? <span className="dim">unreadable</span> : s.count}</td>
        <td>{s.oldest ? <When iso={s.oldest.at} /> : <span className="dim">-</span>}</td>
        <td className="num tnum">{fmtBytes(s.bytes)}</td>
      </tr>
    );
  };
  return (
    <>
      <p className="set-lede">
        <span className="mono">{d.root}</span> · {d.sets.length} sets · {fmtBytes(total)} in all · the newest {d.keep} of each
        managed set are kept{fewer.length > 0 && <> ({fewer.map((s) => `${s.keep} of ${s.name}`).join(', ')})</>}. Inventory written <When iso={d.generatedAt} />
        {d.stale && <span className="set-warn"> - stale; the bothy-inventory timer may not be running</span>}.
      </p>
      <div className="tbl-wrap set-tbl">
        <table className="tbl">
          <thead>
            <tr><th scope="col">Set</th><th scope="col">Newest</th><th scope="col" className="num">Copies</th><th scope="col">Oldest</th><th scope="col" className="num">Size</th></tr>
          </thead>
          <tbody>
            {managed.map(row)}
            {other.length > 0 && (
              <tr className="set-tbl-sep"><td colSpan={5}>Not written by today’s backup script, so nothing rotates them</td></tr>
            )}
            {other.map(row)}
          </tbody>
        </table>
      </div>
      <p className="set-note set-tbl-note">
        Every file here holds credentials - the database dump includes Keycloak’s password hashes and the env set is .env
        itself - so the directories are mode 700 and Files does not serve them.
      </p>
    </>
  );
}

function Schedule({ d }: { d: BackupsResult | null }) {
  const t = d?.timer;
  return (
    <div className="kv-list">
      <div className="kv"><div className="kv-k">Timer</div><div className="kv-v">
        <span className="mono">stacks-backup.timer</span>, daily at 03:00, catching up after the box was off
        {t?.unit && (
          <span className="set-note">
            {t.active === 'active' ? 'Active.' : <b>Not active ({t.active ?? 'unknown'}).</b>}
            {t.last && <> Last ran {t.last}.</>}{t.next && <> Next {t.next}.</>}
          </span>
        )}
      </div></div>
      <div className="kv"><div className="kv-k">Take one now</div><div className="kv-v">
        <Cmd>just backup</Cmd>
        <span className="set-note">Postgres (pg_dumpall), Grafana’s database, .env, VictoriaMetrics, Loki, Alloy’s positions, the audit logs and trash, and the notes. A failure in one does not stop the others.</span>
      </div></div>
      <div className="kv"><div className="kv-k">Restore</div><div className="kv-v">
        By hand, from a shell: <Cmd>just restore-postgres &lt;file&gt;</Cmd> and the same for grafana, env,
        victoriametrics and loki - <Link className="link" to={filesHref('guide', 'stacks', 'docs/guide/backups.md')}>the backups guide</Link>{' '}
        has each one.
        <span className="set-note">Deliberately not a button: a restore overwrites every database on the box.</span>
      </div></div>
    </div>
  );
}
