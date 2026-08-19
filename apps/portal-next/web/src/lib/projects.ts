// Declared projects - the third discovery source, alongside Traefik and Docker.
//
// Traefik and Docker can only report what is CURRENTLY RUNNING and routed. That
// leaves two blind spots the portal could never see out of:
//
//   * a project that is switched off has nothing to discover, so it vanished
//     from the box entirely rather than showing as "off", and
//   * a project made of plain host processes (a `just dev` / `tilt up` harness
//     on ordinary ports) is invisible even while it runs - it is neither a
//     container nor, unless someone hand-wrote a file-route, a Traefik service.
//
// So each project declares itself in a `project.dev.yml` at its repo root, and
// the host-side collector (~/stacks/apps/portal-collector) resolves that against
// real host state - TCP-probing declared ports, reading container exit codes -
// into the projects.json this module consumes.
//
// Declared services are converted into ordinary PortalNodes so the rest of the
// app (systems rollup, Overview, Services, Topology) needs no special case: a
// declared service is just another node with a group.

import type { PortalNode, Status, ServiceType, NodeContainer } from './discover';

// ALL SEVEN THE COLLECTOR CAN EMIT. `collision` and `unverified` were missing
// here while collect.py has emitted both since the port probe learned to identify
// its listener, so they fell through the `?? 'unknown'` guard below - which is
// why nothing broke, and why nothing said they were unhandled either.
export type CollectorState =
  | 'up' | 'starting' | 'stopped' | 'stuck' | 'collision' | 'unverified' | 'unknown';

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
  // `collision` is POSITIVE evidence that this service is not running - the
  // collector identified the listener on its port as something else - so it is
  // off, not unmeasured, and the project rollup in collect.py already folds it in
  // with stopped. Reading it as `unknown` here made the service word disagree with
  // the project word about the same fact.
  collision: 'stopped',
  // `unverified` is the opposite: something is listening and the collector could
  // not say what. That is a statement about its own knowledge, and `unknown` is
  // the portal's word for exactly that.
  unverified: 'unknown',
  unknown: 'unknown',
};

const KNOWN_TYPES = new Set<ServiceType>([
  'web', 'database', 'cache', 'queue', 'storage', 'observability', 'runtime', 'edge',
]);

const serviceTypeOf = (t?: string | null): ServiceType =>
  t && KNOWN_TYPES.has(t as ServiceType) ? (t as ServiceType) : 'runtime';

/**
 * The live container behind a declared service, or null when there is not one.
 *
 * THIS IS THE WHOLE OF #91 THAT CAN BE BUILT SAFELY, and it is worth saying why
 * it is a lookup rather than a start button of its own.
 *
 * A declared service names a container in `project.dev.yml`. That name is a
 * DECLARATION - it says what the project would create, not what exists. Docker's
 * own list (fetched with `?all=1`, so it carries stopped containers too) is the
 * only thing that can say whether the container is actually there, and the two
 * answers lead to two different products:
 *
 *   · the container EXISTS and is stopped -> `/containers/<name>/start`, which
 *     `bothy-control` already performs and `guard.VERBS` already allows. No new
 *     grant, no new verb, no new route. The affordance is the only thing missing.
 *   · the container DOES NOT EXIST -> creating it is `/containers/create`, which
 *     the write socket proxy refuses by holding CONTAINERS=0, on the grounds that
 *     a create with a bind mount of `/` is root on this box
 *     (apps/bothy-control/compose.yml). Bothy cannot do it and must not learn to.
 *
 * So this returns null in the second case, `nodeOf` leaves `container` null, and
 * ActionCell draws nothing - which is the honest answer rather than a button
 * whose only possible outcome is a refusal.
 *
 * THE LOOKUP IS EXACT, and that is a boundary rather than a detail. Compose
 * numbers its containers (`cvops-api-1`), so a declaration naming `cvops-api`
 * must resolve to nothing rather than to the nearest thing with that prefix -
 * matching loosely here would aim a verb at a container nobody named.
 */
export function liveContainer(
  svc: CollectorService,
  live: ReadonlyMap<string, NodeContainer>,
): NodeContainer | null {
  return svc.container ? live.get(svc.container) ?? null : null;
}

function nodeOf(
  project: CollectorProject,
  svc: CollectorService,
  live: ReadonlyMap<string, NodeContainer>,
): PortalNode {
  const status = STATE_TO_STATUS[svc.state] ?? 'unknown';
  // Only offer a link to something actually listening - a link to a stopped
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
    // A declaration IS the identity - the project wrote its own key down in
    // project.dev.yml, which is a stronger claim than anything derived from a
    // compose label. Identity and display grouping are the same here because
    // there is no label on a declared host process to move it with; they are
    // still two fields, so a declared service can be regrouped later without
    // moving its URL, exactly like a discovered one.
    system: project.key,
    group: project.key,
    // A declared project brings its own display name, so it needs no lookup -
    // which is the point of the field: every node carries the name a human
    // should see, however that node came into existence.
    groupTitle: project.name || project.key,
    groupKind: project.kind === 'stack' || project.kind === 'infra' ? project.kind : 'project',
    parent: null,
    depth: null,
    order: 0,
    hidden: false,
    route: null,
    // THE CONTAINER DOCKER REPORTS, NOT A STUB BUILT FROM THE DECLARATION.
    //
    // This field used to be a flat `null`, and that deleted an affordance the
    // declaration was supposed to add: `withDeclared` removes the discovered node
    // for every container a project declares, so declaring a project TOOK AWAY the
    // restart/stop/start control its containers had before it was declared, and
    // left a stopped one with no way back at all. The row for a container docker
    // was holding, exited, said "nothing to act on".
    //
    // Carrying docker's own object also gives ServiceActions the second argument
    // it has always wanted: `verbsFor(status, container.state)` reads `exited` and
    // offers Start, where the collector's five words could only say `stopped`.
    //
    // Only `container` is taken from discovery. Everything else on this node -
    // identity, grouping, display name, ports, description - stays the
    // declaration's, because that is what the declaration is FOR. `dependsOn`
    // stays empty even though the labels to fill it now arrive with this
    // container; see the note on that field.
    container: liveContainer(svc, live),
    // A declared host port is bound by a process on this box, not published by
    // docker, so it is loopback-scoped from the portal's point of view.
    ports: svc.port
      ? [{ hostIp: '127.0.0.1', hostPort: svc.port, proto: 'tcp', scope: 'loopback' as const }]
      : [],
    status,
    serviceType: serviceTypeOf(svc.type),
    volumes: [],
    // Empty here is "nobody wrote it down", not "it has no dependencies".
    // `project.dev.yml` could grow a `dependsOn:` key and feed this the same way
    // compose does; it does not have one today, and inventing edges from the
    // service list would be exactly the inference this work exists to remove.
    //
    // NOT read off the container above, now that there is one. A declared
    // service's container is present or absent depending on whether anybody has
    // run the project, so edges derived from its compose labels would appear and
    // vanish with it - a wiring diagram that changes shape when a container is
    // removed is describing the daemon, not the project. resolveEdges() keys its
    // lookup table on those labels either way, so a declared node can still be
    // the far end of somebody else's edge; it just never claims one of its own.
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
 *
 * It wins on IDENTITY, not on FACTS. The discovered node is dropped, but the
 * container it carried is handed to the declared node that replaced it - see
 * `liveContainer`. Before that, "wins" meant the container was thrown away along
 * with the node, and declaring a project silently disabled the one tier that can
 * act on it.
 */
export function withDeclared(nodes: PortalNode[], projects: CollectorProject[]): PortalNode[] {
  if (!projects.length) return nodes;

  const claimed = new Set<string>();
  for (const p of projects) {
    for (const s of p.services) if (s.container) claimed.add(s.container);
  }

  // Built from the nodes BEFORE the filter below, and from every node rather than
  // only the claimed ones: a declaration that names a container docker has never
  // created must find nothing here, and the only way to be sure of that is to look
  // at the whole list docker actually returned.
  const live = new Map<string, NodeContainer>();
  for (const n of nodes) if (n.container?.name) live.set(n.container.name, n.container);

  const kept = nodes.filter((n) => !(n.container?.name && claimed.has(n.container.name)));
  const declared = projects.flatMap((p) => p.services.map((s) => nodeOf(p, s, live)));
  return [...kept, ...declared];
}
