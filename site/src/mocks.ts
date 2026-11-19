/**
 * The app mocks on the Home page are not pictures: every control inside them works, locally, and does nothing real.
 * Rows can be picked, a filter takes typing, switches flip, checkboxes toggle (they are real inputs, so they work
 * without this file too), buttons press and answer in the mock's own status line, and the diagram's boxes can be
 * highlighted. The data is example data and says so on the mock's face. The mocks of the pinned story and of the
 * "See it move" video are the two deliberate exceptions and are not touched here.
 * One lazy chunk (enhance.ts), loaded only where a [data-mock] is.
 */
const qa = <T extends HTMLElement>(sel: string, from: ParentNode = document) => [...from.querySelectorAll<T>(sel)];

/** Say something in the mock's status line, then put the usual text back. */
const timers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
function say(foot: HTMLElement | null, text: string, hold = 3200) {
  if (!foot) return;
  foot.textContent = text;
  clearTimeout(timers.get(foot));
  timers.set(
    foot,
    setTimeout(() => {
      foot.textContent = foot.dataset.mkFoot ?? '';
    }, hold),
  );
}

/** A pressed look on a button for a moment, for feedback that does not depend on :active (touch, keyboard). */
function flash(btn: HTMLElement) {
  btn.classList.add('is-pressed');
  setTimeout(() => btn.classList.remove('is-pressed'), 280);
}

/** Rows that can be picked: one at a time, pressed again to let go. */
function pickable(mock: HTMLElement) {
  const foot = mock.querySelector<HTMLElement>('[data-mk-foot]');
  const rows = qa<HTMLButtonElement>('.mk-row', mock);
  for (const b of rows)
    b.addEventListener('click', () => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      for (const o of rows) {
        o.setAttribute('aria-pressed', String(o === b && on));
        o.closest('li')?.classList.toggle('is-open', o === b && on);
      }
      if (on) say(foot, b.dataset.mkPick ?? '', 60000);
      else if (foot) say(foot, foot.dataset.mkFoot ?? '', 0);
    });
}

for (const mock of qa('[data-mock="overview"]')) {
  pickable(mock);
  const foot = mock.querySelector<HTMLElement>('[data-mk-foot]');
  const filter = mock.querySelector<HTMLInputElement>('[data-mk-filter]');
  const empty = mock.querySelector<HTMLElement>('.mk-empty');
  const items = qa('[data-mk-item]', mock);
  const apply = () => {
    const q = (filter?.value ?? '').trim().toLowerCase();
    let n = 0;
    for (const li of items) {
      const hit = !q || (li.textContent ?? '').toLowerCase().includes(q);
      li.hidden = !hit;
      if (hit) n++;
    }
    if (empty) empty.hidden = n > 0;
  };
  filter?.addEventListener('input', apply);
  mock.querySelector<HTMLButtonElement>('[data-mk-refresh]')?.addEventListener('click', (e) => {
    flash(e.currentTarget as HTMLElement);
    for (const li of items) {
      li.classList.remove('is-ping');
      void li.offsetWidth;
      li.classList.add('is-ping');
    }
    say(foot, foot?.dataset.mkRefreshed ?? '');
  });
}

for (const mock of qa('[data-mock="files"]')) {
  pickable(mock);
  const foot = mock.querySelector<HTMLElement>('[data-mk-foot]');
  const sw = mock.querySelector<HTMLInputElement>('[data-mk-write]');
  sw?.addEventListener('change', () => {
    if (sw.checked) say(foot, sw.dataset.mkWrite ?? '', 60000);
    else say(foot, foot?.dataset.mkFoot ?? '', 0);
  });
}

// The dry-run card: the checks are real checkboxes; the button runs the example again
for (const mock of qa('[data-mock="checks"]')) {
  const foot = mock.querySelector<HTMLElement>('[data-mk-foot]');
  const boxes = qa<HTMLInputElement>('[data-mk-check]', mock);
  const pattern = foot?.dataset.mkCount ?? '';
  const count = () => {
    const n = boxes.filter((b) => b.checked).length;
    if (foot) say(foot, pattern.replace('{n}', String(n)).replace('{t}', String(boxes.length)), 60000);
  };
  for (const b of boxes) b.addEventListener('change', count);
  const again = mock.querySelector<HTMLButtonElement>('[data-mk-rerun]');
  if (again) {
    again.hidden = false;
    again.addEventListener('click', () => {
      flash(again);
      if (foot) say(foot, foot.dataset.mkFoot ?? '', 0);
      mock.closest('[data-run]')?.dispatchEvent(new CustomEvent('mk:rerun'));
    });
  }
}

// the dry-run terminal has its own Replay, the same run as the card's button
for (const btn of qa<HTMLButtonElement>('[data-mk-replay]')) {
  btn.hidden = false;
  btn.addEventListener('click', () => btn.closest('[data-run]')?.dispatchEvent(new CustomEvent('mk:rerun')));
}

// Under the hood: a box can be highlighted (the button is the keyboard route; the box itself takes a click too)
for (const hood of qa('[data-mock="hood"]')) {
  const nodes = qa('.hn', hood);
  const set = (node: HTMLElement | null, on: boolean) => {
    for (const n of nodes) {
      const mine = n === node && on;
      n.classList.toggle('is-pick', mine);
      n.querySelector('.hn-trace')?.setAttribute('aria-pressed', String(mine));
    }
    hood.classList.toggle('has-pick', on);
  };
  hood.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('a, code')) return;
    const node = t.closest<HTMLElement>('.hn');
    if (node) set(node, !node.classList.contains('is-pick'));
  });
}
