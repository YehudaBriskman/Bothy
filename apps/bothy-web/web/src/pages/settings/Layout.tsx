// Layout & navigation - where Bothy opens and how the Overview is arranged, per
// browser. These three blocks SAVE (GitLab's model): a landing page or a hidden
// panel changes a page you are not looking at, so a draft you can discard is
// kinder than a change that already happened somewhere else.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { SettingBlock } from '../../components/settings/SettingBlock';
import { Choice } from '../../components/settings/bits';
import { useLayout } from '../../lib/usePrefs';
import { announcePref } from '../../lib/usePrefs';
import {
  LANDINGS, OVERVIEW_PANELS, readRaw, type Landing, type Layout, type OverviewPanel, type SectionOrder,
} from '../../lib/prefs';
import { COLLAPSED_KEY, parseCollapsed } from '../../lib/collapse';
import { Button } from '../../components/ui/Button';

function useDraft<T>(saved: T): [T, (v: T) => void, boolean, () => void] {
  const [draft, setDraft] = useState<T | null>(null);
  const value = draft ?? saved;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  return [value, setDraft, dirty, () => setDraft(null)];
}

export function LayoutSettings() {
  const [layout, setLayout] = useLayout();
  const [landing, setLanding, landingDirty, resetLanding] = useDraft<Landing>(layout.landing);
  const [order, setOrder, orderDirty, resetOrder] = useDraft<SectionOrder>(layout.sectionOrder);
  const [hidden, setHidden, hiddenDirty, resetHidden] = useDraft<OverviewPanel[]>(layout.hiddenPanels);

  const save = (patch: Partial<Layout>, done: () => void) => { setLayout({ ...layout, ...patch }); done(); };

  return (
    <>
      <SettingBlock
        id="landing"
        badge="this browser"
        dirty={landingDirty}
        onSave={() => save({ landing }, resetLanding)}
        onDiscard={resetLanding}
        saveNote="Takes effect the next time Bothy is opened without a page in the address."
      >
        <Choice<Landing>
          label="Open Bothy on"
          name="landing"
          value={landing}
          onChange={setLanding}
          options={LANDINGS.map((l) => ({ value: l.path, label: l.label, hint: l.path }))}
        />
        <p className="set-note">
          Only a bare visit is redirected. A link to a page always opens that page, and the Overview stays one click away
          in the topbar.
        </p>
      </SettingBlock>

      <SettingBlock
        id="overview-order"
        badge="this browser"
        dirty={orderDirty}
        onSave={() => save({ sectionOrder: order }, resetOrder)}
        onDiscard={resetOrder}
      >
        <Choice<SectionOrder>
          label="The system matrix on the Overview lists"
          name="overview-order"
          value={order}
          onChange={setOrder}
          options={[
            { value: 'bothy-first', label: 'Bothy first', hint: 'Bothy’s own tiers, then projects. The default.' },
            { value: 'projects-first', label: 'Projects first', hint: 'Your projects above the box’s own services.' },
          ]}
        />
      </SettingBlock>

      <SettingBlock
        id="overview-panels"
        badge="this browser"
        dirty={hiddenDirty}
        onSave={() => save({ hiddenPanels: hidden }, resetHidden)}
        onDiscard={resetHidden}
      >
        <fieldset className="set-checks">
          <legend className="set-choice-l">Show on the Overview</legend>
          {OVERVIEW_PANELS.map((p) => {
            const on = !hidden.includes(p.id);
            return (
              <label className="set-check" key={p.id}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => setHidden(on ? [...hidden, p.id].sort() : hidden.filter((x) => x !== p.id))}
                />
                <span className="set-check-t">{p.label}</span>
                <span className="set-check-h">{p.hint}</span>
              </label>
            );
          })}
        </fieldset>
        <p className="set-note">
          The status line and the attention strip are not in this list and cannot be hidden: “is anything broken” is the
          question the Overview exists to answer.
        </p>
      </SettingBlock>

      <SettingBlock id="remembered-layout" badge="this browser">
        <Remembered />
      </SettingBlock>
    </>
  );
}

function Remembered() {
  const [, bump] = useState(0);
  const collapsed = parseCollapsed(readRaw(COLLAPSED_KEY));
  const rows = [
    {
      key: COLLAPSED_KEY,
      what: 'Collapsed service groups',
      now: collapsed.length ? `${collapsed.length} collapsed: ${collapsed.slice(0, 4).join(', ')}${collapsed.length > 4 ? '…' : ''}` : 'none - every group open',
      where: <Link className="link" to="/control/services">Services</Link>,
      set: collapsed.length > 0,
    },
    {
      key: 'bothy-control-nav-v1',
      what: 'Control menu',
      now: readRaw('bothy-control-nav-v1') === '1' ? 'collapsed to icons' : 'labels shown',
      where: <Link className="link" to="/control">Control</Link>,
      set: readRaw('bothy-control-nav-v1') === '1',
    },
    {
      key: 'bothy-files-panes-v1',
      what: 'Pane widths in Files',
      now: readRaw('bothy-files-panes-v1') ? 'resized by you' : 'defaults',
      where: <Link className="link" to="/files/edit">Files editor</Link>,
      set: !!readRaw('bothy-files-panes-v1'),
    },
    {
      key: 'bothy-settings-nav-v1',
      what: 'Collapsed blocks in Settings',
      now: readRaw('bothy-settings-nav-v1') && readRaw('bothy-settings-nav-v1') !== '{}' ? 'some collapsed' : 'every block open',
      where: <span className="dim">here</span>,
      set: !!readRaw('bothy-settings-nav-v1') && readRaw('bothy-settings-nav-v1') !== '{}',
    },
  ];
  const reset = (key: string) => {
    try { localStorage.removeItem(key); } catch { /* not fatal */ }
    announcePref(key);
    bump((n) => n + 1);
  };
  return (
    <div className="tbl-wrap scroll-shade set-tbl">
      <table className="tbl as-cards">
        <thead>
          <tr><th scope="col">What</th><th scope="col">Now</th><th scope="col">Where</th><th scope="col"><span className="sr-only">Reset</span></th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.what}<span className="set-cell-sub mono">{r.key}</span></td>
              <td data-label="Now">{r.now}</td>
              <td data-label="Where">{r.where}</td>
              <td className="set-cell-act">
                <Button variant="ghost" size="sm" disabled={!r.set} onClick={() => reset(r.key)}
                  aria-label={`Reset ${r.what.toLowerCase()}`}>
                  Reset
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
