import { CopyButton } from './CopyButton.tsx';

export interface TerminalLine {
  cmd: string;
  /** Shown after the command in a muted style; never copied. */
  note?: string;
}

/**
 * A block of shell commands.
 *
 * The prompt is decoration (`aria-hidden`, unselectable) so a drag-select or the
 * copy button yields commands that paste and run. The copy icon is revealed by
 * enhance.ts; without JavaScript the block is still readable and selectable.
 */
export function Terminal({ label, lines }: { label: string; lines: TerminalLine[] }) {
  const copyText = lines.map((l) => l.cmd).join('\n');
  return (
    <figure className="term" data-copy-text={copyText}>
      <figcaption>{label}</figcaption>
      <pre translate="no" dir="ltr" tabIndex={0}>
        <code>
          {lines.map((l, i) => (
            <span className="term-line" key={i}>
              <span className="prompt" aria-hidden="true">
                ${' '}
              </span>
              {l.cmd}
              {l.note ? <span className="term-note">{`  # ${l.note}`}</span> : null}
              {'\n'}
            </span>
          ))}
        </code>
      </pre>
      <CopyButton />
    </figure>
  );
}
