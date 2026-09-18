// Updates - what is newer than what this box runs. READ-ONLY (build step 3 of
// docs/plans/updates.md).
//
// Everything on this page comes from one viewer read, GET /-/api/updates/status:
// apps/bothy-ops/updates.toml (the catalog) merged with the file the host's
// discovery timer writes. The registries, docker inspect and git are the HOST's
// business (apps/bothy-ops/discover_updates.py); the browser and bothy-ops only
// read the result.
//
// NO BUTTON APPLIES ANYTHING, and the page says so in words rather than by
// leaving a button out. Applying needs the host updater (step 4); until then the
// page names the file to edit and the recipe to run, and copies it for you -
// the Credentials and Backups pages' convention for an action a shell owns.
//
// Colour: a level badge is NOT state, so it is drawn in the neutral chrome and
// told apart by its word (and a heavier outline for a major). Drift and a failed
// check ARE state - what runs is not what the repo says - so they take the
// reserved warning colour, always with a glyph and a word beside it.

import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowUpRight, Check, Lock } from 'lucide-react';
import { filesHref } from '../files/routes';
import { SettingBlock } from '../../components/settings/SettingBlock';
import { Cmd, Loading, Prose, Refusal, When, useLoad } from '../../components/settings/bits';
import {
  fetchUpdates, pinFile, publishBehind,
  type Channel, type Level, type UpdateRow, type UpdatesStatus,
} from '../../lib/updates';

export function UpdatesSettings() {
  const { data, error, loading, reload } = useLoad((signal) => fetchUpdates(signal));
  // The page's own read is the freshest count there is; hand it to the nav.
  useEffect(() => { if (data) publishBehind(data.summary.behind); }, [data]);
  const fail = (
    <>
      <Refusal error={error} needs="viewer" what="update checks" />
      <button type="button" className="btn ghost sm" onClick={reload}>Retry</button>
    </>
  );
  return (
    <>
      {data && <Freshness d={data} />}
      <SettingBlock id="update-components" badge="read-only · viewer">
        {loading ? <Loading rows={8} /> : error ? fail : data && <Components d={data} />}
      </SettingBlock>
      <SettingBlock id="update-channels" badge="from updates.toml">
        {loading ? <Loading rows={3} /> : <Channels d={data} />}
      </SettingBlock>
      <SettingBlock id="update-apply" badge="not built yet">
        <Apply d={data} />
      </SettingBlock>
    </>
  );
}

function Freshness({ d }: { d: UpdatesStatus }) {
  const s = d.summary;
  if (!d.discovery.present) {
    return (
      <p className="set-fresh is-stale" role="status">
        <AlertTriangle size={14} aria-hidden="true" />
        <span><Prose text={d.discovery.hint ?? 'Nothing discovered yet - run `just updates-discover` on the host.'} /></span>
      </p>
    );
  }
  return (
    <p className={`set-fresh ${d.discovery.stale ? 'is-stale' : ''}`} role="status">
      {d.discovery.stale && <AlertTriangle size={14} aria-hidden="true" />}
      <span>
        {s.components} components · {s.updates} with a newer version · <b>{s.behind}</b> a minor or more behind
        {s.drift > 0 && <> · {s.drift} drifting</>}
        {s.errors > 0 && <> · {s.errors} not checked</>}. Checked on the host <When iso={d.discovery.generatedAt} />
        {d.discovery.stale
          ? ` - older than two ${d.policy.discoverEveryHours}-hour runs; the bothy-updates-discover timer may not be running.`
          : '.'}
      </span>
    </p>
  );
}

// ── the table ────────────────────────────────────────────────────────────────

const GROUP_TITLE: Record<Channel, string> = {
  auto: 'Automatic - patch releases only, in the night window',
  notify: 'Notify - shown here, applied by a person',
  manual: 'Manual only - the auth boundary, the databases and one-way migrations',
};

const LEVEL_WORD: Record<Level, string> = { patch: 'patch', minor: 'minor', major: 'major' };

function LevelBadge({ level }: { level: Level }) {
  return <span className="upd-level" data-level={level}>{LEVEL_WORD[level]}</span>;
}

function Components({ d }: { d: UpdatesStatus }) {
  const groups = (['auto', 'notify', 'manual'] as Channel[])
    .map((ch) => ({ ch, rows: d.components.filter((r) => r.channel === ch) }))
    .filter((g) => g.rows.length > 0);
  return (
    <>
      <div className="tbl-wrap set-tbl">
        <table className="tbl upd-tbl">
          <thead>
            <tr>
              <th scope="col">Component</th>
              <th scope="col">Pinned</th>
              <th scope="col">Running</th>
              <th scope="col">Available</th>
              <th scope="col">Channel</th>
              <th scope="col">Notes</th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.ch}>
              <tr className="set-tbl-sep"><td colSpan={6}>{GROUP_TITLE[g.ch]}</td></tr>
              {g.rows.map((r) => <Row key={r.id} r={r} />)}
            </tbody>
          ))}
        </table>
      </div>
      <p className="set-note set-tbl-note">
        <b>Drift</b> means what runs is not what the repository pins - usually a pin that was merged and never applied.
        Running the component’s recipe fixes it. A <b>floating</b> pin (a tag like <span className="mono">v3.7</span> or{' '}
        <span className="mono">17</span>) can move under you; when it has, the new image is offered as the smallest step.
      </p>
    </>
  );
}

function Row({ r }: { r: UpdateRow }) {
  const d = r.discovered;
  return (
    <tr>
      <td className="upd-name">
        <b>{r.title}</b>
        <span className="set-cell-sub mono">{r.id} · {r.class}</span>
      </td>
      {/* data-label: below 640px the table becomes one card per component, and
          a cell names itself because the header row is no longer beside it. */}
      <td data-label="Pinned"><Pinned r={r} /></td>
      <td data-label="Running"><Running r={r} /></td>
      <td data-label="Available"><Available r={r} /></td>
      <td data-label="Channel"><ChannelCell r={r} /></td>
      <td data-label="Notes" className="upd-notes">
        {r.oneWay && (
          <span className="upd-oneway" title={r.oneWayWhy ?? undefined}>
            <Lock size={12} aria-hidden="true" />one-way
          </span>
        )}
        <a className="link upd-cl" href={r.changelog} target="_blank" rel="noreferrer noopener">
          Changelog<ArrowUpRight size={12} aria-hidden="true" />
        </a>
        <span className="set-cell-sub">{d?.checkedAt ? <>checked <When iso={d.checkedAt} /></> : 'not checked yet'}</span>
      </td>
    </tr>
  );
}

function Pinned({ r }: { r: UpdateRow }) {
  const c = r.discovered?.current;
  const where = pinFile(r.pins[0]);
  if (!c) return <><span className="dim">-</span><span className="set-cell-sub mono">{where}</span></>;
  return (
    <>
      <span className="mono upd-tag">{c.tag ?? c.version ?? 'a digest'}</span>
      <span className="set-cell-sub">
        {c.float ? 'floating tag · ' : !c.tag ? 'by digest · ' : ''}
        <span className="mono">{where}</span>
        {r.pins.length > 1 && ` +${r.pins.length - 1}`}
      </span>
    </>
  );
}

const tagOf = (image: string | null): string | null => {
  if (!image) return null;
  const at = image.indexOf('@');
  if (at >= 0) return null;
  const last = image.split('/').pop() ?? '';
  return last.includes(':') ? last.split(':').pop() ?? null : null;
};

function Running({ r }: { r: UpdateRow }) {
  const d = r.discovered;
  if (!d) return <span className="dim">-</span>;
  const run = d.running[0];
  const shown = d.runningVersion ?? tagOf(run?.image ?? null) ?? (run ? 'pinned digest' : null);
  return (
    <>
      {shown ? <span className="mono upd-tag">{shown}</span> : (
        <span className="dim">{r.source === 'github' ? 'this checkout' : r.class === 'cluster' ? 'cluster not reached' : 'not running'}</span>
      )}
      {d.drift && (
        <span className="upd-drift set-warn" title={d.drift}>
          <AlertTriangle size={12} aria-hidden="true" />drift
        </span>
      )}
    </>
  );
}

function Available({ r }: { r: UpdateRow }) {
  const d = r.discovered;
  if (!d) return <span className="dim">not checked yet</span>;
  if (d.error) {
    return (
      <>
        <span className="set-warn upd-err"><AlertTriangle size={12} aria-hidden="true" />not checked</span>
        <span className="set-cell-sub upd-why" title={d.error}>{d.error}</span>
      </>
    );
  }
  if (!d.latest || !d.latest.level) {
    return <span className="upd-current"><Check size={13} aria-hidden="true" />up to date</span>;
  }
  const moved = d.current.float && d.latest.tag === d.current.tag;
  const others = (['patch', 'minor', 'major'] as Level[])
    .map((lv) => d.candidates[lv])
    .filter((c) => c && c.tag !== d.latest!.tag);
  return (
    <>
      <span className="upd-avail">
        <span className="mono upd-tag">{moved ? `${d.latest.tag} (moved)` : d.latest.tag}</span>
        <LevelBadge level={d.latest.level} />
      </span>
      {others.length > 0 && (
        <span className="set-cell-sub">
          also {others.map((c, i) => (
            <span key={c!.tag}>{i > 0 && ', '}<span className="mono">{c!.tag}</span> ({c!.level})</span>
          ))}
        </span>
      )}
      {d.latest.publishedAt && <span className="set-cell-sub">released <When iso={d.latest.publishedAt} /></span>}
    </>
  );
}

const CHANNEL_WORD: Record<Channel, string> = { auto: 'auto', notify: 'notify', manual: 'manual' };

function ChannelCell({ r }: { r: UpdateRow }) {
  const eff = r.effectiveChannel;
  return (
    <>
      <span className="upd-channel" data-channel={eff ?? r.channel}>{CHANNEL_WORD[eff ?? r.channel]}</span>
      {eff && eff !== r.channel && (
        <span className="set-cell-sub">
          {r.channel} component; {r.level === 'major' ? 'a major is always manual' : 'only its patches are automatic'}
        </span>
      )}
    </>
  );
}

// ── channels and the window ─────────────────────────────────────────────────

function Channels({ d }: { d: UpdatesStatus | null }) {
  const count = (ch: Channel) => d?.components.filter((r) => r.channel === ch).length ?? 0;
  const p = d?.policy;
  return (
    <div className="kv-list">
      <div className="kv"><div className="kv-k">auto</div><div className="kv-v">
        Patch releases only, applied in the night window. A minor of an auto component is only <b>notified</b>; a major is{' '}
        <b>manual</b>. Only stateless and time-series components may be auto - the catalog cannot widen that.
        {d && <span className="set-note">{count('auto')} components.</span>}
      </div></div>
      <div className="kv"><div className="kv-k">notify</div><div className="kv-v">
        Shown here with its step, and applied by a person. Grafana, Traefik, Bothy itself and the cluster add-ons.
        {d && <span className="set-note">{count('notify')} components.</span>}
      </div></div>
      <div className="kv"><div className="kv-k">manual</div><div className="kv-v">
        Never offered as one click: Keycloak, both oauth2-proxies, the Docker socket proxies and Postgres, and <b>any</b>{' '}
        major of anything.
        {d && <span className="set-note">{count('manual')} components.</span>}
      </div></div>
      <div className="kv"><div className="kv-k">Night window</div><div className="kv-v">
        {p ? <>{p.windowStart}–{p.windowEnd}</> : '03:30–05:00'} local time, only if that night’s{' '}
        <span className="mono">{p?.requireBackup ?? 'stacks-backup.service'}</span> succeeded and <span className="mono">just doctor</span>{' '}
        was green. At most {p?.maxAutoPerNight ?? 1} automatic update a night, stopping at the first failure. A rollback or a failed
        verify pauses auto for that component until an operator clears it.
        <span className="set-note">
          <b>Nothing runs automatically yet.</b> This is the approved policy the updater (build step 4) will be held to.
        </span>
      </div></div>
      <div className="kv"><div className="kv-k">One-way</div><div className="kv-v">
        <span className="upd-oneway"><Lock size={12} aria-hidden="true" />one-way</span>{' '}
        marks a component whose first start on a new version migrates data the old version cannot read - rolling back is
        a restore, not a re-pin. Take a backup first.
      </div></div>
    </div>
  );
}

// ── applying, by hand ───────────────────────────────────────────────────────

function Apply({ d }: { d: UpdatesStatus | null }) {
  const todo = (d?.components ?? []).filter((r) => r.level || r.discovered?.drift);
  return (
    <>
      <div className="set-refusal upd-notbuilt" role="note">
        <p>
          <b>Applying an update from this page is not built yet.</b> The page only reads. Until the host updater exists,
          update from a shell on the box: edit the pin, then run the component’s recipe.
        </p>
      </div>
      {todo.length > 0 && (
        <div className="set-subsection">
          <h3 className="set-h3">By hand, today<span className="set-h3-sub">{todo.length} components</span></h3>
          <ul className="upd-todo">
            {todo.map((r) => {
              const d2 = r.discovered!;
              const target = d2.latest?.tag;
              return (
                <li key={r.id}>
                  <b>{r.title}</b>{' '}
                  {target && d2.latest?.level ? (
                    <>
                      <span className="mono">{d2.current.tag ?? 'digest'}</span> → <span className="mono">{target}</span>{' '}
                      <LevelBadge level={d2.latest.level} />: edit{' '}
                      {[...new Set(r.pins.map(pinFile))].map((f, i) => (
                        <span key={f}>{i > 0 && ' and '}<span className="mono">{f}</span></span>
                      ))}, then <Cmd>{r.apply}</Cmd>
                    </>
                  ) : (
                    <>drifting - <Cmd>{r.apply}</Cmd> brings it back to its pin</>
                  )}
                  {d2.drift && <span className="set-note">Drift: {d2.drift}.</span>}
                  {r.oneWay && <span className="set-note">One-way: run <Cmd>just backup</Cmd> first. {r.oneWayWhy}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="kv-list">
        <div className="kv"><div className="kv-k">Check again</div><div className="kv-v">
          <Cmd>just updates-discover</Cmd>
          <span className="set-note">
            Read-only: it asks the registries, GitHub and the helm index, and pulls nothing. Answers are cached for five hours;
            add <span className="mono">--no-cache</span> to ask again. The <span className="mono">bothy-updates-discover</span> timer
            runs it every {d?.policy.discoverEveryHours ?? 6} hours.
          </span>
        </div></div>
        <div className="kv"><div className="kv-k">After an update</div><div className="kv-v">
          <Cmd>just doctor</Cmd>
          <span className="set-note">Then the component’s own canaries, which the design lists per component.</span>
        </div></div>
        <div className="kv"><div className="kv-k">The design</div><div className="kv-v">
          <Link className="link" to={filesHref('read', 'stacks', 'docs/plans/updates.md')}>docs/plans/updates.md</Link>
          <span className="set-note">Plans, snapshots, verify and rollback - and why the updater runs on the host, not in a container.</span>
        </div></div>
      </div>
    </>
  );
}
