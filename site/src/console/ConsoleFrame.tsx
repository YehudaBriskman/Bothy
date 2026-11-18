import fragments from './generated/fragments.json';

/**
 * The glass frame holding the example console: four views switched by real radio tabs, with their captions.
 *
 * The HTML is built ahead of time by `npm run render-console` from fixtures and the console's own stylesheet
 * (see scripts/render-console.mjs) and held by console.test.ts, so this component renders a constant string and has
 * nothing to hydrate. A page that shows it must load `src/styles/console.css` once. One frame per page: its radio ids
 * are fixed.
 */
export function ConsoleFrame() {
  return <div className="cf-host" dangerouslySetInnerHTML={{ __html: fragments.frame }} />;
}
