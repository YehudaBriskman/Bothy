// Facts Settings reads out of the stack's own config files, through bothy-files
// (`viewer`). Read, never assumed: the retention a page states must be the one
// the running config says, so it is parsed from the file on every visit rather
// than written into the page.
//
//   monitoring/compose.yml                       -retentionPeriod=15d  (VictoriaMetrics)
//   monitoring/loki-config.yml                   retention_period: 168h (Loki)
//   monitoring/provisioning/alerting/rules.yml   the Grafana alert rules
//
// The parsers are regexes over one known file each, not a YAML parser - the
// browser bundle has none and these three shapes do not justify one. Each says
// `null` rather than guessing when its line is not there.

import { readFile } from './files';

export const VM_COMPOSE = 'monitoring/compose.yml';
export const LOKI_CONFIG = 'monitoring/loki-config.yml';
export const ALERT_RULES = 'monitoring/provisioning/alerting/rules.yml';

export async function readStackFile(path: string, signal?: AbortSignal): Promise<{ content: string; mtime: number }> {
  if (import.meta.env.DEV) return (await import('./stack-config.dev')).readStackFileMock(path);
  const r = await readFile('stacks', path, signal);
  return { content: r.content, mtime: r.mtime };
}

export interface Retention { value: string; line: number; human: string }

const human = (v: string): string => {
  const m = /^(\d+)([hdwmy])$/.exec(v);
  if (!m) return v;
  const n = Number(m[1]);
  const days = m[2] === 'h' ? n / 24 : m[2] === 'd' ? n : m[2] === 'w' ? n * 7 : m[2] === 'm' ? n * 30 : n * 365;
  return Number.isInteger(days) ? `${days} day${days === 1 ? '' : 's'}` : `${n} hours`;
};

function findLine(text: string, re: RegExp): Retention | null {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('#')) continue;
    const m = re.exec(lines[i]);
    if (m) return { value: m[1], line: i + 1, human: human(m[1]) };
  }
  return null;
}

export const vmRetention = (compose: string) => findLine(compose, /-retentionPeriod=(\w+)/);
export const lokiRetention = (config: string) => findLine(config, /^\s*retention_period:\s*(\w+)/);

export interface AlertRule {
  uid: string;
  title: string;
  group: string;
  interval: string | null;
  for: string | null;
  severity: string | null;
  summary: string | null;
  line: number;
}

/** The rules in Grafana's alerting provisioning file, by their fixed indentation. */
export function parseAlertRules(text: string): AlertRule[] {
  const out: AlertRule[] = [];
  let group = '';
  let interval: string | null = null;
  let cur: AlertRule | null = null;
  const unq = (s: string) => s.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  text.split('\n').forEach((raw, i) => {
    let m: RegExpExecArray | null;
    if ((m = /^\s{4}name:\s*(.+)$/.exec(raw))) { group = unq(m[1]); interval = null; return; }
    if ((m = /^\s{4}interval:\s*(.+)$/.exec(raw))) { interval = unq(m[1]); return; }
    if ((m = /^\s{6}- uid:\s*(.+)$/.exec(raw))) {
      cur = { uid: unq(m[1]), title: '', group, interval, for: null, severity: null, summary: null, line: i + 1 };
      out.push(cur);
      return;
    }
    if (!cur) return;
    const c = cur as AlertRule;
    if ((m = /^\s{8}title:\s*(.+)$/.exec(raw))) c.title = unq(m[1]);
    else if ((m = /^\s{8}for:\s*(.+)$/.exec(raw))) c.for = unq(m[1]);
    else if ((m = /^\s{10}severity:\s*(.+)$/.exec(raw))) c.severity = unq(m[1]);
    else if ((m = /^\s{10}summary:\s*(.+)$/.exec(raw))) c.summary = unq(m[1]);
  });
  return out;
}
