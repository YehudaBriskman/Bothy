/**
 * The site's few icons: one line style (1.6 px stroke, round caps and joins, `currentColor`), drawn here so there is
 * no icon font and no request. All decorative: the text next to each one carries the meaning.
 */

const common = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
};

export type IconName =
  | 'star'
  | 'chevron'
  | 'arrow'
  | 'external'
  | 'linux'
  | 'docker'
  | 'shield'
  | 'repeat'
  | 'stop'
  | 'leave'
  | 'check'
  | 'file'
  | 'tag';

const PATHS: Record<IconName, string[]> = {
  star: ['m12 3.5 2.6 5.3 5.8.85-4.2 4.1 1 5.8L12 16.8l-5.2 2.75 1-5.8-4.2-4.1 5.8-.85z'],
  chevron: ['m6 9 6 6 6-6'],
  arrow: ['M5 12h14', 'm13 6 6 6-6 6'],
  external: ['M7 17 17 7', 'M8 7h9v9'],
  // a penguin is a logo; this is a plain terminal window instead
  linux: ['M3.5 5.5h17v13h-17z', 'm7 10 3 2-3 2', 'M12.5 14.5h4'],
  // a box of containers, not anyone's logo
  docker: ['M4 11h16v4a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z', 'M7 7.5h3v3.5H7z', 'M10.5 7.5h3v3.5h-3z', 'M14 7.5h3v3.5h-3z'],
  shield: ['M12 3.5 19 6v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z', 'm8.8 12 2.2 2.2 4.4-4.4'],
  repeat: ['M17 3.5 20 6.5l-3 3', 'M4 11.5v-1a4 4 0 0 1 4-4h12', 'M7 20.5 4 17.5l3-3', 'M20 12.5v1a4 4 0 0 1-4 4H4'],
  stop: ['M8.2 3.5h7.6l5.7 5.7v7.6l-5.7 5.7H8.2l-5.7-5.7V9.2z', 'M12 8v5', 'M12 16.3v.2'],
  leave: ['M4 11 12 4l8 7v9H4z', 'M10 20v-5h4v5'],
  check: ['m5 12.5 4.2 4.2L19 7'],
  file: ['M6 3.5h8l4 4v13H6z', 'M14 3.5v4h4'],
  tag: ['M3.5 12.5v-8h8l9 9-8 8z', 'M8 8h.01'],
};

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg {...common} width={size} height={size} className={className}>
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** GitHub's mark, used only as the link to the project on GitHub (as their logo guidelines allow). */
export function GitHubMark({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
