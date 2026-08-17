// Five chips, painted by the theme they advertise rather than by a list of
// colours copied out of it.
//
// The element carries `data-bothy-theme`, and every theme file declares its
// palette for a SUBTREE as well as for :root precisely so this works - so a
// swatch cannot show a colour the theme does not actually have. That is the
// whole reason it is worth a component: the alternative is a table of five
// hexes per theme, maintained by hand, and first to go stale.
//
// `--sw-N` with the real token as the FALLBACK resolves both kinds of theme in
// one expression. A theme FILE applies its whole palette here, so var(--accent)
// is already right and --sw-1 is undefined. The two BUILT-INS live on :root
// only - they are index.css itself - so themes/picker.css supplies --sw-1..5
// for them instead, guarded by checks/theme-contract.mjs. Neither case needs
// this component to know which kind it is drawing.

export function ThemeSwatch({ id }: { id: string }) {
  return (
    <span className="theme-swatch" data-bothy-theme={id} aria-hidden="true">
      <i style={{ background: 'var(--sw-1, var(--accent))' }} />
      <i style={{ background: 'var(--sw-2, var(--st-up))' }} />
      <i style={{ background: 'var(--sw-3, var(--st-warn))' }} />
      <i style={{ background: 'var(--sw-4, var(--st-down))' }} />
      <i style={{ background: 'var(--sw-5, var(--a5))' }} />
    </span>
  );
}
