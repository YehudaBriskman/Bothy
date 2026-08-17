// Who is signed in, and what they may do.
//
// THERE IS NO `/-/api/me`, AND THERE DOES NOT NEED TO BE. oauth2-proxy already
// serves `/oauth2/userinfo` from the session cookie, and that route is already
// published by `oauth2-endpoints@file` (PathPrefix(`/oauth2/`), priority 100) so
// the login flow can reach its own callback. Measured against the live box, it
// returns exactly the fields a settings page needs:
//
//   {"user":"<subject uuid>","email":"…","groups":["viewer","editor","operator",
//    "offline_access","default-roles-devbox","uma_authorization"],
//    "preferredUsername":"devssh"}
//
// Signed out it is a 401 rather than a body, which is the same first-class result
// the file API already models - not an error, an invitation.
//
// THE ROLES HERE ARE FOR THE INTERFACE, NEVER FOR THE BOUNDARY. Hiding a button
// the user's role forbids is a courtesy that saves a round trip and a 403; the
// decision is taken at the edge by a forwardAuth middleware that reads a signed
// cookie and never trusts anything the browser says. If this file is ever the
// only thing standing between a user and an action, that action is unprotected.

/** Roles the realm defines. `shell` is deliberately granted to nobody. */
export type Role = 'viewer' | 'editor' | 'operator' | 'shell';

export const ROLE_MEANING: Record<Role, string> = {
  viewer: 'Read the box: browse files, search their contents, download bytes.',
  editor: 'Change a file on disk. Saves write straight to the working tree.',
  operator: 'Act on what is running - restart, stop and start a service.',
  shell: 'An arbitrary terminal. Granted to nobody, on purpose.',
};

export interface Me {
  user: string;
  email: string;
  preferredUsername: string;
  /** Every group the token carries, Keycloak's own bookkeeping included. */
  groups: string[];
  /** Just the four the realm defines - what the interface actually reasons about. */
  roles: Role[];
}

const KNOWN: Role[] = ['viewer', 'editor', 'operator', 'shell'];

/** Null when signed out. Never throws for a 401 - being signed out is ordinary. */
export async function fetchMe(signal?: AbortSignal): Promise<Me | null> {
  const r = await fetch('/oauth2/userinfo', {
    signal,
    headers: { Accept: 'application/json' },
    redirect: 'manual',
  });
  if (r.status === 401 || r.status === 403 || r.type === 'opaqueredirect') return null;
  if (!r.ok) throw new Error(`identity lookup failed: ${r.status}`);
  const raw = (await r.json()) as Partial<Me> & { groups?: string[] };
  const groups = raw.groups ?? [];
  return {
    user: raw.user ?? '',
    email: raw.email ?? '',
    preferredUsername: raw.preferredUsername ?? raw.email ?? 'unknown',
    groups,
    roles: KNOWN.filter((k) => groups.includes(k)),
  };
}

export const hasRole = (me: Me | null, role: Role): boolean => !!me?.roles.includes(role);

/** Where to send someone who needs a session, returning them to this page. */
export const signInHref = (): string =>
  `/oauth2/sign_in?rd=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
export const signOutHref = (): string => '/oauth2/sign_out?rd=%2F';
