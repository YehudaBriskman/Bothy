// Services & placement - apps/bothy-collector/placement.yml as a table, edited
// through the config forms (bothy-files, /-/api/config/*).
//
// The rules come from /config/fields, which returns every written value WITH the
// file's mtime in one read, so an edit is always against a version somebody can
// name. A rule's identity is its match list, which is what the service sends as
// `service` for a placement-rule site (yamlpatch.placement_rule_id).
//
// EDITING IS NOT APPLYING, and here the gap is short: the collector re-reads the
// file every 30 seconds and the Overview follows on its next poll. The service's
// own appliedNote says so after a save, verbatim.
//
// Only values that are already written can be changed. Adding a rule, removing
// one or giving a rule a key it does not have is an edit to the file in Files -
// yamlpatch splices existing scalars and never re-serialises, which is what keeps
// every comment in that file byte-identical.

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pencil } from 'lucide-react';
import { SettingBlock } from '../../components/settings/SettingBlock';
import { Loading, useLoad } from '../../components/settings/bits';
import { loadFields, patchField, refusalOf, whyRefused, type FieldSite, type FieldsResult } from '../../lib/config';
import { useOperator } from '../../lib/session';
import { filesHref } from '../files/routes';
import { Button } from '../../components/ui/Button';

const PATH = 'apps/bothy-collector/placement.yml';
const KEYS = ['section', 'subgroup', 'title', 'group'] as const;
type Key = (typeof KEYS)[number];

interface Rule {
  id: string;
  match: string[];
  line: number;
  sites: Partial<Record<Key, FieldSite>>;
}

function rulesOf(r: FieldsResult): Rule[] {
  const by = new Map<string, Rule>();
  for (const s of r.fields) {
    if (s.kind !== 'placement-rule') continue;
    const key = s.field.replace(/^placement\./, '') as Key;
    if (!KEYS.includes(key)) continue;
    const rule = by.get(s.service) ?? { id: s.service, match: s.service.split(','), line: s.line, sites: {} };
    rule.sites[key] = s;
    rule.line = Math.min(rule.line, s.line);
    by.set(s.service, rule);
  }
  return [...by.values()].sort((a, b) => a.line - b.line);
}

export function PlacementSettings() {
  const { data, error, loading, reload } = useLoad((signal) => loadFields('stacks', PATH, signal));
  const rules = useMemo(() => (data ? rulesOf(data) : []), [data]);
  const { me } = useOperator();
  // A courtesy, never the gate: the edge refuses a patch without `editor`.
  const canEdit = import.meta.env.DEV || !!me?.roles.includes('editor');

  return (
    <>
      <SettingBlock id="placement-rules" badge="editor to change">
        {loading ? <Loading rows={5} /> : error ? (
          <ReadRefusal error={error} onRetry={reload} />
        ) : !rules.length ? (
          <p className="set-empty">placement.yml declares no rules, so every system is shown where its compose file puts it.</p>
        ) : (
          <RuleTable rules={rules} mtime={data!.mtime} canEdit={canEdit} onSaved={reload} />
        )}
      </SettingBlock>

      <SettingBlock id="placement-edit" badge="read-only">
        <div className="kv-list">
          <div className="kv"><div className="kv-k">Precedence</div><div className="kv-v">
            This file, then a container’s own <span className="mono">dev.portal.section</span> and{' '}
            <span className="mono">dev.portal.subgroup</span> labels, then the default from where its compose file lives.
            The most specific match wins: a container beats its project, a project beats a namespace.
          </div></div>
          <div className="kv"><div className="kv-k">Here</div><div className="kv-v">
            Change a value a rule already sets. Needs <span className="mono">editor</span>; every save is one line in the
            file, one snapshot and one line in the config audit log.
          </div></div>
          <div className="kv"><div className="kv-k">In Files</div><div className="kv-v">
            Add a rule, remove one, or give a rule a key it does not have yet -{' '}
            <Link className="link mono" to={filesHref('edit', 'stacks', PATH)}>{PATH}</Link>.
          </div></div>
        </div>
      </SettingBlock>
    </>
  );
}

function ReadRefusal({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const r = refusalOf(error, 'read');
  return (
    <div className="set-refusal" role="status">
      <p><b>{r.title}</b> {r.detail}</p>
      <Button variant="ghost" size="sm" onClick={onRetry}>Retry</Button>
    </div>
  );
}

function RuleTable({ rules, mtime, canEdit, onSaved }: {
  rules: Rule[]; mtime: number; canEdit: boolean; onSaved: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="tbl-wrap set-tbl">
      <table className="tbl set-placement">
        <thead>
          <tr>
            <th scope="col">Matches</th>
            {KEYS.map((k) => <th scope="col" key={k}>{k[0].toUpperCase() + k.slice(1)}</th>)}
            <th scope="col"><span className="sr-only">Edit</span></th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => editing === r.id ? (
            <EditRow key={r.id} rule={r} mtime={mtime} onCancel={() => setEditing(null)}
              onSaved={() => { setEditing(null); onSaved(); }} />
          ) : (
            <tr key={r.id}>
              <td>
                {r.match.map((m) => <span key={m} className="set-match mono">{m}</span>)}
                <span className="set-cell-sub">line {r.line}</span>
              </td>
              {KEYS.map((k) => (
                <td key={k}>{r.sites[k] ? <span>{r.sites[k]!.value}</span> : <span className="dim">not set</span>}</td>
              ))}
              <td className="set-cell-act">
                {canEdit && (
                  <Button variant="ghost" size="sm" onClick={() => setEditing(r.id)}
                    aria-label={`Edit the rule for ${r.match.join(', ')}`}>
                    <Pencil size={13} aria-hidden="true" /> Edit
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EditRow({ rule, mtime, onCancel, onSaved }: {
  rule: Rule; mtime: number; onCancel: () => void; onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Partial<Record<Key, string>>>(
    Object.fromEntries(KEYS.filter((k) => rule.sites[k]).map((k) => [k, rule.sites[k]!.value])),
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'err' | 'ok'; text: string } | null>(null);
  const changed = KEYS.filter((k) => rule.sites[k] && draft[k] !== rule.sites[k]!.value);
  const invalid = KEYS.map((k) => (rule.sites[k] ? [k, whyRefused(draft[k] ?? '', rule.sites[k]!.maxLength)] as const : null))
    .filter((x): x is readonly [Key, string | null] => !!x && !!x[1]);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    let base = mtime;
    try {
      for (const k of changed) {
        // Sequential, carrying each answer's mtime into the next patch: two
        // values in one rule are two writes, and the second must not look stale
        // because of the first.
        const res = await patchField({ root: 'stacks', path: PATH, field: `placement.${k}`, value: draft[k]!, baseMtime: base, service: rule.id });
        base = res.mtime;
        setMsg({ kind: 'ok', text: res.appliedNote });
      }
      onSaved();
    } catch (e) {
      const r = refusalOf(e, 'write');
      setMsg({ kind: 'err', text: `${r.title} ${r.detail}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className="set-edit-row">
      <td>{rule.match.map((m) => <span key={m} className="set-match mono">{m}</span>)}</td>
      {KEYS.map((k) => (
        <td key={k}>
          {rule.sites[k] ? (
            <label className="set-field">
              <span className="sr-only">{k} for {rule.match.join(', ')}</span>
              <input
                className="set-input"
                value={draft[k] ?? ''}
                maxLength={rule.sites[k]!.maxLength}
                onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                aria-invalid={invalid.some(([ik]) => ik === k)}
                spellCheck={false}
              />
            </label>
          ) : <span className="dim">not set</span>}
        </td>
      ))}
      <td className="set-cell-act">
        <div className="set-edit-btns">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={save}
            disabled={busy || !changed.length || invalid.length> 0}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
        {(invalid.length > 0 || msg) && (
          <p className={`set-edit-msg ${msg?.kind === 'err' || invalid.length ? 'is-err' : ''}`} role="status">
            {invalid.length ? invalid[0][1] : msg?.text}
          </p>
        )}
      </td>
    </tr>
  );
}
