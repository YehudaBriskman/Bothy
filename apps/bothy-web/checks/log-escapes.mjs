// An escape in a log line never reaches the pane - run with ./checks/run.sh
//
// lib/ansi.ts, over the escapes the containers on this box actually emit
// (design audit CL-13). It matters more than it looks: the log panes are the
// one surface in the app whose content is written by somebody else, and a
// regular expression that is a little wrong here either leaves `␛[32m` on
// screen or eats a character out of a line somebody is reading to debug
// something.
//
// The cases that matter are the last two families: a lone ESC at the end of a
// TRUNCATED line (every pane here caps the number of lines and the service caps
// their length), and a plain line with a `[` in it - a timestamp, an array
// index - which must come through untouched.

import { stripAnsi } from './ansi.mjs';

const E = '\u001B';
let bad = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)}${ok ? '' : ` want=${JSON.stringify(want)} got=${JSON.stringify(got)}`}`);
};

// ── SGR: the colours a logger writes ────────────────────────────────────────
check('a coloured status code', stripAnsi(`${E}[32m200${E}[0m`), '200');
check('bold and reset', stripAnsi(`${E}[1mGET${E}[22m /`), 'GET /');
check('a 256-colour run', stripAnsi(`${E}[38;5;208mwarn${E}[0m x`), 'warn x');
check('a truecolour run', stripAnsi(`${E}[38;2;255;0;0merr${E}[39m`), 'err');
check('several in one line',
  stripAnsi(`${E}[2m12:04:01${E}[0m ${E}[31mERROR${E}[0m boom`), '12:04:01 ERROR boom');

// ── the codes a progress bar or a spinner leaves behind ─────────────────────
check('erase line', stripAnsi(`${E}[2Kpulling`), 'pulling');
check('cursor up', stripAnsi(`${E}[1A${E}[2Kdone`), 'done');
check('hide cursor (a private-mode CSI)', stripAnsi(`${E}[?25lworking`), 'working');

// ── OSC: a title, or a hyperlink ────────────────────────────────────────────
check('an OSC title ended with BEL', stripAnsi(`${E}]0;a title\u0007text`), 'text');
check('an OSC ended with ST', stripAnsi(`${E}]8;;http://x${E}\\link`), 'link');

// ── a truncated line can end mid-escape ─────────────────────────────────────
check('a lone trailing ESC', stripAnsi(`cut here${E}`), 'cut here');
check('a truncated CSI', stripAnsi(`cut here${E}[3`), 'cut here');

// ── and everything else is left exactly alone ───────────────────────────────
for (const line of [
  'GET /-/api/kube/catalog 200 4ms',
  'level=info msg="listening" addr=[::]:8080',
  'a[0] = 1; b[1] = 2',
  'time="2026-09-22T18:00:00Z" level=warn',
  '',
  '  indentation and trailing spaces  ',
]) check(`untouched: ${JSON.stringify(line).slice(0, 40)}`, stripAnsi(line), line);

console.log(bad ? `\n  ${bad} FAILED` : '\n  all pass');
process.exit(bad ? 1 : 0);
