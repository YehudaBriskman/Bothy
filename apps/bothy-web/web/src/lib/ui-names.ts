// What a link to a published UI is CALLED - the Overview's "Open a UI" panel and
// the Control landing's Quick links both read it, through lib/systems.ts uiPorts().
//
// Discovery names a node after its compose service, title-cased, and that is the
// right name for a row in the Services table: it says which container it is. It is
// the wrong name for a link to an interface, where the question is "which product
// opens". Four were wrong on this box (2026-09-22):
//
//   Oauth2 Proxy Headlamp   the proxy in front of Headlamp is what publishes the port
//   Manifests · Sonarqube   the owning compose project, and a title-cased product
//   Victoriametrics         title case cannot know a product's own casing
//   Cadvisor                likewise
//
// So: when a system publishes exactly ONE UI, the link takes the system's title -
// set by placement.yml or a dev.portal label, which is a person saying what the
// thing is called - and only its product part, after the last " · " (placement
// titles read "Identity · Keycloak": area, then product). Otherwise the service
// name stays, with its product casing corrected from the table below. The port is
// shown beside the name either way, so two links never become indistinguishable.
//
// IMPORTS NOTHING, so checks/run.sh compiles it with a bare tsc and
// checks/control-home.mjs holds the cases above.

/** Products whose own casing title case gets wrong, keyed lowercase with no
 *  separators. Only names that actually appear; a guess here would be a typo
 *  waiting to happen. */
export const PRODUCT_CASE: Record<string, string> = {
  cadvisor: 'cAdvisor',
  victoriametrics: 'VictoriaMetrics',
  sonarqube: 'SonarQube',
  pgadmin: 'pgAdmin',
  minio: 'MinIO',
  oauth2proxy: 'OAuth2 Proxy',
};

const key = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');

/** One name, with the product casing fixed where the table knows it. */
export function productCase(name: string): string {
  return name.split(' · ').map((part) => PRODUCT_CASE[key(part)] ?? part).join(' · ');
}

/** The product part of a placed system title: "Identity · Keycloak" -> "Keycloak". */
export function productOf(title: string): string {
  const parts = title.split(' · ').map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? title;
}

/**
 * The display name for a UI link.
 *
 * `name`       the node's discovered name ("Oauth2 Proxy Headlamp")
 * `groupTitle` its system's title ("Headlamp", "Monitoring · Grafana")
 * `uisInGroup` how many UI links that system publishes
 */
export function uiName(name: string, groupTitle: string | null | undefined, uisInGroup: number): string {
  if (uisInGroup === 1 && groupTitle && groupTitle.trim()) return productCase(productOf(groupTitle));
  return productCase(name);
}
