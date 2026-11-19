/**
 * The copy controls (components/CopyButton.tsx): loaded by enhance.ts only on a page that has one. One delegated
 * click handler. It copies with the Clipboard API, falls back to a selected-text execCommand, and when both fail it
 * selects the text and says "Press Ctrl+C". The popup text is swapped, and the icon morphs to a check for 1.5 s
 * (styles/site.css; with reduced motion the swap is instant). Nothing is stored and nothing leaves the page.
 */
const ui = document.querySelector<HTMLElement>('main')?.dataset ?? {};
const T = {
  copy: ui.copyIdle ?? 'Copy',
  copied: ui.copied ?? 'Copied',
  label: ui.copyLabel ?? 'Copy command',
  fail: ui.copyFail ?? 'Press Ctrl+C',
};

const live = document.createElement('p');
live.className = 'visually-hidden';
live.setAttribute('role', 'status');
document.body.append(live);

const textOf = (b: HTMLElement): { text: string; node: Element | null } => {
  if (b.dataset.copy != null)
    return { text: b.dataset.copy, node: b.parentElement?.querySelector('pre, code') ?? null };
  const host = b.closest<HTMLElement>('[data-copy-text]');
  if (host?.dataset.copyText != null) return { text: host.dataset.copyText, node: host.querySelector('pre, code') };
  const pre = b.closest('.code')?.querySelector('pre') ?? null;
  return { text: (pre?.textContent ?? '').replace(/\n$/, ''), node: pre };
};

async function write(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;inset-block-start:0;inset-inline-start:0;opacity:0;pointer-events:none';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

const timers = new WeakMap<HTMLElement, number>();
function say(b: HTMLElement, state: 'ok' | 'fail' | '', msg: string) {
  const tip = b.querySelector('.cp-tip');
  if (tip) tip.textContent = msg;
  if (state) b.dataset.state = state;
  else delete b.dataset.state;
  live.textContent = state ? msg : '';
}

for (const b of document.querySelectorAll<HTMLElement>('[data-cp]')) {
  b.setAttribute('aria-label', T.label);
  const tip = b.querySelector('.cp-tip');
  if (tip) tip.textContent = T.copy;
}

document.addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-cp]');
  if (!b) return;
  const { text, node } = textOf(b);
  const ok = await write(text);
  window.clearTimeout(timers.get(b));
  if (ok) say(b, 'ok', T.copied);
  else {
    if (node) getSelection()?.selectAllChildren(node);
    say(b, 'fail', T.fail);
  }
  timers.set(
    b,
    window.setTimeout(() => say(b, '', T.copy), ok ? 1500 : 3000),
  );
});
