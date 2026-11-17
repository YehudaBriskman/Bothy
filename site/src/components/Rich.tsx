import type { ReactNode } from 'react';

/**
 * Inline markup for message strings: `code` and **bold**, nothing else.
 *
 * Code is always left-to-right and untranslatable, so a command inside a
 * right-to-left sentence keeps its shape and a translation tool leaves it alone.
 */
export function Rich({ text }: { text: string }): ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/);
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={i} translate="no" dir="ltr">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    return part;
  });
}
