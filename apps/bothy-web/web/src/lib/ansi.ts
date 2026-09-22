// ── ANSI escapes out of a log line (design audit CL-13) ──────────────────────
//
// A pod or a container that thinks it is writing to a terminal emits SGR colour
// codes, and they arrived in the log panes as literal text: a 200 in an access
// log read `␛[32m200␛[0m`, three tokens of noise around the one number that
// matters, in a monospace pane where every character costs a column.
//
// STRIPPED RATHER THAN RENDERED. Mapping SGR to `--st-*` was the alternative,
// and it hands a service's idea of "red" authority over a palette this app has
// spent an audit making one thing - a container that paints its debug lines
// bright green would paint them the app's "up" colour. A log line's severity is
// in its words, and the panes already read those.
//
// This module imports NOTHING, so checks/run.sh can compile and run it on its
// own - which is the whole reason it is a module rather than three copies of a
// regular expression.

/** The escape sequences a logger actually emits:
 *  - CSI (`ESC [ … final`): SGR colour (`m`), and the cursor and erase codes a
 *    progress bar leaves behind;
 *  - OSC (`ESC ] … BEL` or `ESC \`): window titles, and hyperlinks;
 *  - two-character escapes (`ESC =`, `ESC >`, …);
 *  - an UNTERMINATED CSI or a lone trailing ESC, because every pane here caps
 *    the line length and a truncated line can end mid-escape. Leaving `␛[3` on
 *    screen is the same defect as leaving `␛[32m`. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B(?:\[[0-?]*[ -/]*(?:[@-~]|$)|\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|[@-Z\\-_]|$)/g;

export function stripAnsi(line: string): string {
  return line.replace(ANSI, '');
}
