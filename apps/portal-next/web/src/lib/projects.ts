// Declared projects — the third discovery source, alongside Traefik and Docker.
//
// Traefik and Docker can only report what is CURRENTLY RUNNING and routed. That
// leaves two blind spots the portal could never see out of:
//
//   * a project that is switched off has nothing to discover, so it vanished
//     from the box entirely rather than showing as "off", and
//   * a project made of plain host processes (a `just dev` / `tilt up` harness
//     on ordinary ports) is invisible even while it runs — it is neither a
//     container nor, unless someone hand-wrote a file-route, a Traefik service.
//
// So each project declares itself in a `project.dev.yml` at its repo root, and
// the host-side collector (~/stacks/apps/portal-collector) resolves that against
// real host state — TCP-probing declared ports, reading container exit codes —
// into the projects.json this module consumes.
//
// Declared services are converted into ordinary PortalNodes so the rest of the
// app (systems rollup, Overview, Services, Topology) needs no special case: a
// declared service is just another node with a group.

import type { PortalNode, Status, ServiceType } from './discover';

export type CollectorState = 'up' | 'starting' | 'stopped' | 'stuck' | 'unknown';

export interface CollectorService {
  name: string;
  description?: string | null;
  type?: string | null;
  ui?: boolean;
  container?: string | null;
  port?: number | null;
  state: CollectorState;
  detail?: string | null;
  logs?: { kind: 'container' | 'host'; selector: string; filter?: string | null } | null;
}

export interface CollectorProject {
  key: string;
  name: string;
  kind?: string | null;
  description?: string | null;
  root?: string | null;
  start?: string | null;
  state: 'live' | 'degraded' | 'stopped' | 'stuck' | 'unknown';
  services: CollectorService[];
  error?: string | null;
}

export interface CollectorPayload {
  generatedAt: number;
  source: string;
  dockerReachable: boolean;
  projects: CollectorProject[];
}

// The collector says `stuck` where the portal says `down`; both mean "meant to
// be up, isn't". Everything else is 1:1.
const STATE_TO_STATUS: Record<CollectorState, Status> = {
  up: 'up',
  starting: 'starting',
  stopped: 'stopped',
  stuck: 'down',
  unknown: 'unknown',
};

const KNOWN_TYPES = new Set<ServiceType>([
  'web', 'database', 'cache', 'queue', 'storage', 'observability', 'runtime', 'edge',
]);

const serviceTypeOf = (t?: string | null): ServiceType =>
  t && KNOWN_TYPES.has(t as ServiceType) ? (t as ServiceType) : 'runtime';

function nodeOf(project: CollectorProject, svc: CollectorService): PortalNode {
  const status = STATE_TO_STATUS[svc.state] ?? 'unknown';
  // Only offer a link to something actually listening — a link to a stopped
  // port is a browser error page dressed up as a feature.
  const url = svc.ui && svc.port && status === 'up' ? `http://${location.hostname}:${svc.port}` : null;
  return {
    id: `declared:${project.key}:${svc.name}`,
    kind: 'host',
    name: svc.name,
    host: null,
    aliases: [],
    path: '/',
    url,
    browsable: url != null,
    group: project.key,
    groupKind: project.kind === 'stack' || project.kind === 'infra' ? project.kind : 'project',
    parent: null,
    depth: null,
    order: 0,
    hidden: false,
    route: null,
    container: null,
    // A declared host port is bound by a process on this box, not published by
    // docker, so it is loopback-scoped from the portal's point of view.
    ports: svc.port
      ? [{ hostIp: '127.0.0.1', hostPort: svc.port, proto: 'tcp', scope: 'loopback' as const }]
      : [],
    status,
    serviceType: serviceTypeOf(svc.type),
    volumes: [],
    // A declared host process has no compose labels, so there is nothing to read
    // an edge from — and nothing to declare it a one-shot either. Empty here is
    // "nobody wrote it down", not "it has no dependencies". `project.dev.yml`
    // could grow a `dependsOn:` key and feed this the same way compose does; it
    // does not have one today, and inventing edges from the service list would
    // be exactly the inference this work exists to remove.
    dependsOn: [],
    completesOnPurpose: false,
    uptimeSecs: null,
    icon: 'server',
    desc: svc.detail || svc.description || 'Declared in project.dev.yml',
    logs: svc.logs ?? null,
  };
}

/**
 * Fold declared projects into the discovered node list.
 *
 * A declaration WINS over discovery for the same container: mpeg-redis and
 * mpeg-keycloak are started by `docker run` with no compose labels, so discovery
 * files them under 'unmanaged' infra. The declaration knows they belong to their
 * project, and keeping both copies would double-count them in every total.
 */
export function withDeclared(nodes: PortalNode[], projects: CollectorProject[]): PortalNode[] {
  if (!projects.length) return nodes;

  const claimed = new Set<string>();
  for (const p of projects) {
    for (const s of p.services) if (s.container) claimed.add(s.container);
  }

  const kept = nodes.filter((n) => !(n.container?.name && claimed.has(n.container.name)));
  const declared = projects.flatMap((p) => p.services.map((s) => nodeOf(p, s)));
  return [...kept, ...declared];
}
