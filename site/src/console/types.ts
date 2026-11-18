/**
 * The shapes the fixtures take. Each is a SUBSET of a type the product owns, named in its comment; console.test.ts
 * reads the product's source and fails if a fixture carries a field the product does not have, or a value outside
 * the product's unions. Nothing here is invented: an optional field is optional because the product's is.
 */

/** apps/bothy-web/web/src/lib/discover.ts: Status. */
export type Status = 'up' | 'down' | 'starting' | 'stopped' | 'done' | 'dormant' | 'unknown';
/** discover.ts: Kind. */
export type Kind = 'routed' | 'orphan-route' | 'unrouted' | 'host';

/** discover.ts: Port. */
export interface Port {
  hostIp: string;
  hostPort: number;
  containerPort?: number;
  proto?: string;
  scope: 'loopback' | 'public';
}

/** discover.ts: NodeContainer. */
export interface NodeContainer {
  id: string;
  name: string;
  image?: string;
  statusText?: string;
  health: { Status?: string; FailingStreak?: number } | null;
  labels: Record<string, string>;
}

/** discover.ts: NodeRoute (only what the table reads). */
export interface NodeRoute {
  router: string;
  provider?: string;
  serverUrls: string[];
}

/** discover.ts: PortalNode, the fields the Services table reads. */
export interface ServiceNode {
  id: string;
  kind: Kind;
  name: string;
  host: string | null;
  group: string;
  groupTitle: string;
  browsable: boolean;
  url: string | null;
  ports: Port[];
  status: Status;
  route?: NodeRoute | null;
  container: NodeContainer | null;
}

export type Tone = 'ok' | 'warn' | 'bad' | 'off' | 'unknown';

/** components/control-home/HealthStrip.tsx: Tile. `value` is the two text spans the product builds it from. */
export interface HealthTile {
  key: string;
  label: string;
  value: { num: string; of: string } | { text: string };
  sub: string;
  to: string;
  tone: Tone;
  toneLabel: string;
}

/** lib/files.ts: FileRoot, TreeFile, Commit, FileRead (the fields used). */
export interface FileRoot {
  key: string;
  label?: string;
  readOnly?: boolean;
}
export interface TreeFile {
  path: string;
  size?: number;
  mtime: number;
  writable: boolean;
  dir?: boolean | string;
  lang?: string | null;
  readable?: boolean;
}
export interface Commit {
  sha: string;
  author: string;
  date: string;
  subject: string;
}
export interface FileRead {
  root: string;
  path: string;
  content: string;
  size: number;
  mtime: number;
  writable: boolean;
  history: Commit[];
  lang?: string | null;
  versioned?: boolean;
}

/** cli/internal/install/module.go: ModuleRow, the `--json` line of `bothy module list`. */
export interface ModuleRow {
  name: string;
  installed: boolean;
  core?: boolean;
  description: string;
  memory_mib: number;
  requires: string[];
  provides: string[];
  services: string[];
  dirs?: string[];
  default_in_modes: string[];
}

export interface ServicesFixture {
  nodes: ServiceNode[];
}
export interface HealthFixture {
  tiles: HealthTile[];
}
export interface FilesFixture {
  asOf: string;
  roots: FileRoot[];
  open: string[];
  tree: TreeFile[];
  file: FileRead;
}
export interface ModulesFixture {
  mode: string;
  installed: boolean;
  modules: ModuleRow[];
  example: { release: string };
}
