// File-type icons for the explorer.
//
// A glyph per FAMILY, never per extension. Twenty distinguishable icons in a
// 12px column is twenty things to learn and about six things anyone can actually
// tell apart at that size; the families below are the ones whose difference
// changes what you do with the file - is it prose, is it config, is it a
// picture, is it a thing this page cannot open at all.
//
// The colour is carried by a class rather than a prop so the palette stays in
// the stylesheet with every other colour on this page, and so light and dark are
// declared together.

import {
  Braces, FileArchive, FileCode2, FileCog, FileImage, FileText, FileTerminal,
  FileSpreadsheet, Film, Lock, Music, Package, type LucideIcon,
} from 'lucide-react';

interface IconSpec { Icon: LucideIcon; tone: string; }

const TEXT: IconSpec = { Icon: FileText, tone: '' };

const BY_EXT: Record<string, IconSpec> = {
  md: { Icon: FileText, tone: 'prose' },
  markdown: { Icon: FileText, tone: 'prose' },
  rst: { Icon: FileText, tone: 'prose' },
  txt: TEXT,

  ts: { Icon: FileCode2, tone: 'code' }, tsx: { Icon: FileCode2, tone: 'code' },
  js: { Icon: FileCode2, tone: 'code' }, jsx: { Icon: FileCode2, tone: 'code' },
  mjs: { Icon: FileCode2, tone: 'code' }, cjs: { Icon: FileCode2, tone: 'code' },
  py: { Icon: FileCode2, tone: 'code' }, go: { Icon: FileCode2, tone: 'code' },
  rs: { Icon: FileCode2, tone: 'code' }, java: { Icon: FileCode2, tone: 'code' },
  rb: { Icon: FileCode2, tone: 'code' }, php: { Icon: FileCode2, tone: 'code' },
  c: { Icon: FileCode2, tone: 'code' }, h: { Icon: FileCode2, tone: 'code' },
  css: { Icon: FileCode2, tone: 'code' }, html: { Icon: FileCode2, tone: 'code' },
  sql: { Icon: FileCode2, tone: 'code' },

  json: { Icon: Braces, tone: 'data' }, jsonc: { Icon: Braces, tone: 'data' },
  yml: { Icon: FileCog, tone: 'conf' }, yaml: { Icon: FileCog, tone: 'conf' },
  toml: { Icon: FileCog, tone: 'conf' }, ini: { Icon: FileCog, tone: 'conf' },
  cfg: { Icon: FileCog, tone: 'conf' }, conf: { Icon: FileCog, tone: 'conf' },
  env: { Icon: Lock, tone: 'secret' },

  sh: { Icon: FileTerminal, tone: 'shell' }, bash: { Icon: FileTerminal, tone: 'shell' },
  zsh: { Icon: FileTerminal, tone: 'shell' },

  png: { Icon: FileImage, tone: 'media' }, jpg: { Icon: FileImage, tone: 'media' },
  jpeg: { Icon: FileImage, tone: 'media' }, gif: { Icon: FileImage, tone: 'media' },
  webp: { Icon: FileImage, tone: 'media' }, svg: { Icon: FileImage, tone: 'media' },
  ico: { Icon: FileImage, tone: 'media' }, avif: { Icon: FileImage, tone: 'media' },
  bmp: { Icon: FileImage, tone: 'media' },
  mp4: { Icon: Film, tone: 'media' }, webm: { Icon: Film, tone: 'media' },
  mov: { Icon: Film, tone: 'media' },
  mp3: { Icon: Music, tone: 'media' }, wav: { Icon: Music, tone: 'media' },

  pdf: { Icon: FileSpreadsheet, tone: 'doc' },
  csv: { Icon: FileSpreadsheet, tone: 'data' },
  xlsx: { Icon: FileSpreadsheet, tone: 'doc' }, docx: { Icon: FileSpreadsheet, tone: 'doc' },

  zip: { Icon: FileArchive, tone: 'bin' }, gz: { Icon: FileArchive, tone: 'bin' },
  tgz: { Icon: FileArchive, tone: 'bin' }, tar: { Icon: FileArchive, tone: 'bin' },
  whl: { Icon: Package, tone: 'bin' }, so: { Icon: Package, tone: 'bin' },
  pem: { Icon: Lock, tone: 'secret' }, key: { Icon: Lock, tone: 'secret' },
};

// Named files whose extension is absent or lies about them.
const BY_NAME: [RegExp, IconSpec][] = [
  [/^dockerfile(\..+)?$/i, { Icon: FileCog, tone: 'conf' }],
  [/^containerfile$/i, { Icon: FileCog, tone: 'conf' }],
  [/^(docker-)?compose\.ya?ml$/i, { Icon: FileCog, tone: 'conf' }],
  [/^\.env(\..+)?$/i, { Icon: Lock, tone: 'secret' }],
  [/^(makefile|justfile)$/i, { Icon: FileTerminal, tone: 'shell' }],
  [/^(readme|licen[cs]e|changelog|contributing)(\..+)?$/i, { Icon: FileText, tone: 'prose' }],
];

export function FileIcon({ name, size = 13, className = '' }: {
  name: string; size?: number; className?: string;
}) {
  const base = name.slice(name.lastIndexOf('/') + 1);
  let spec: IconSpec | undefined;
  for (const [re, s] of BY_NAME) if (re.test(base)) { spec = s; break; }
  if (!spec) {
    const dot = base.lastIndexOf('.');
    spec = dot > 0 ? BY_EXT[base.slice(dot + 1).toLowerCase()] : undefined;
  }
  const { Icon, tone } = spec ?? TEXT;
  return <Icon size={size} className={`fx-ico ${tone ? `t-${tone}` : ''} ${className}`} aria-hidden="true" />;
}
