import type { ReactNode } from 'react';

/**
 * The reading text of the two black sections after the story's descent ("What a bothy is", "One console for one
 * machine"). A paragraph is cut into its sentences, one `.mf` each, so the About page's reading animation (lines
 * that light as they cross the middle of the screen, styles/inner.css) lights a sentence at a time. The words are
 * unchanged; the sentences just sit on their own lines. home-sections.ts counts the lit lines and the figure beside
 * the text reacts to the count.
 */
export const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).filter(Boolean);

export function Lines({ text }: { text: string }) {
  return (
    <>
      {sentences(text).map((s) => (
        <p key={s} className="mf mf-sm">
          {s}
        </p>
      ))}
    </>
  );
}

/** A section on the flat page ground, text on one side and a figure on the other. */
export function ReadSection({
  id,
  className,
  flip,
  text,
  figure,
}: {
  id: string;
  className: string;
  flip?: boolean;
  text: ReactNode;
  figure: ReactNode;
}) {
  return (
    <section
      id={id}
      className={`ch ${className} ch-read${flip ? ' is-flip' : ''}`}
      aria-labelledby={`${id}-h`}
      data-read
    >
      <div className="ch-wrap rd-grid">
        <div className="rd-text">{text}</div>
        <div className="rd-side">{figure}</div>
      </div>
    </section>
  );
}
