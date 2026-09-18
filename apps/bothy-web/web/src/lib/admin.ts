// The Settings area's admin reads - bothy-ops admin.py, behind `operator`.
//
//   GET /-/api/admin/users         Keycloak users and their realm roles
//   GET /-/api/admin/credentials   where every credential lives; never a value
//   GET /-/api/admin/backups       backup sets
//   GET /-/api/admin/audit         the four audit logs, filtered and paged
//
// apps/bothy-ops/checks/wiring_admin.py asserts this file names exactly those four
// paths. Every one is a GET, and none changes anything; the edge refuses a POST
// before it reaches the service.
//
// The shapes below are the service's ALLOW-LISTS, restated. A field that is not
// here is not sent - admin.py copies Keycloak's answers and the host inventory
// field by field - so a type here that grew a `value` would be describing a
// field the wire can never carry.
//
// In `vite dev` every call goes to lib/admin.dev.ts, for the reason every other
// *.dev.ts exists: the dev server proxies /-/api/* at the live box and holds no
// session cookie for it.

import { apiFetch } from './http';

export const ROLES = ['viewer', 'editor', 'operator', 'shell'] as const;

export interface AdminUser {
  id: string;
  username: string;
  email: string | null;
  enabled: boolean;
  emailVerified: boolean;
  createdAt: string | null;
  requiredActions: string[];
  /** Of the four Bothy roles, the ones held - in ladder order. */
  roles: string[];
  /** Keycloak's own bookkeeping (`default-roles-devbox`, ...). Grants nothing here. */
  otherRoles: string[];
  /** Credential TYPES only - `password`, `otp`. */
  credentials: string[];
  passwordSetAt: string | null;
  otp: boolean;
  sessions: number;
  lastSeenAt: string | null;
}

export interface UsersResult {
  realm: string;
  client: string;
  fetchedAt: string | null;
  truncated: boolean;
  users: AdminUser[];
}

interface InventoryMeta {
  generatedAt: string | null;
  ageSeconds: number;
  stale: boolean;
}

export interface EnvKey {
  key: string;
  set: boolean;
  credential: boolean;
  placeholder: boolean;
  usedBy: string[];
  purpose?: string | null;
  rotate?: string | null;
}

export interface CredentialFile {
  id: string;
  path: string;
  purpose: string;
  usedBy: string[];
  rotate: string;
  present: boolean | null;
  expectMode: string;
  actualMode?: string | null;
  changed?: string | null;
  bytes?: number;
  error?: string;
}

export interface CredentialClient {
  id: string;
  purpose: string;
  realm: string;
  where: string;
  set: boolean;
  changed: string | null;
  changedScope: string;
}

export interface CredentialsResult extends InventoryMeta {
  env: {
    path: string;
    present?: boolean;
    mode?: string;
    expectMode?: string;
    changed?: string | null;
    keys: EnvKey[];
  };
  files: CredentialFile[];
  clients: CredentialClient[];
}

export interface BackupPoint { name: string; at: string | null; bytes: number }

export interface BackupSet {
  name: string;
  managed?: boolean;
  what?: string | null;
  readable?: boolean;
  mode?: string | null;
  count?: number;
  bytes?: number;
  newest?: BackupPoint | null;
  oldest?: BackupPoint | null;
}

export interface BackupsResult extends InventoryMeta {
  root?: string;
  present?: boolean;
  keep?: number;
  command?: string;
  timer: { unit?: string; active?: string | null; last?: string | null; next?: string | null };
  sets: BackupSet[];
}

export type AuditLogName = 'ops' | 'admin' | 'files' | 'config';

export interface AuditEntry {
  log: AuditLogName;
  kind?: string;
  at: string;
  who: string;
  outcome: string;
  action: string;
  target: string;
  detail: string;
  tookMs: number | null;
}

export interface AuditQuery {
  log?: 'all' | AuditLogName;
  who?: string;
  outcome?: string;
  action?: string;
  offset?: number;
  limit?: number;
}

export interface AuditResult {
  total: number;
  offset: number;
  limit: number;
  skipped: number;
  logs: Partial<Record<AuditLogName, { present: boolean; truncated: boolean; lines: number }>>;
  facets: { who: string[]; outcome: string[]; action: string[] };
  entries: AuditEntry[];
}

const WIRE = {
  refused: (status: number) => `refused with ${status}`,
  notService: 'answered by something that is not bothy-ops - the admin routes may not be deployed yet',
};

export async function fetchUsers(signal?: AbortSignal): Promise<UsersResult> {
  if (import.meta.env.DEV) return (await import('./admin.dev')).usersMock();
  return apiFetch<UsersResult>('/-/api/admin/users', { signal, ...WIRE });
}

export async function fetchCredentials(signal?: AbortSignal): Promise<CredentialsResult> {
  if (import.meta.env.DEV) return (await import('./admin.dev')).credentialsMock();
  return apiFetch<CredentialsResult>('/-/api/admin/credentials', { signal, ...WIRE });
}

export async function fetchBackups(signal?: AbortSignal): Promise<BackupsResult> {
  if (import.meta.env.DEV) return (await import('./admin.dev')).backupsMock();
  return apiFetch<BackupsResult>('/-/api/admin/backups', { signal, ...WIRE });
}

/** Only the parameters that are set are sent; the service refuses unknown ones. */
export function auditQueryString(q: AuditQuery): string {
  const p = new URLSearchParams();
  if (q.log && q.log !== 'all') p.set('log', q.log);
  if (q.who) p.set('who', q.who);
  if (q.outcome) p.set('outcome', q.outcome);
  if (q.action) p.set('action', q.action);
  if (q.offset) p.set('offset', String(q.offset));
  if (q.limit) p.set('limit', String(q.limit));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export async function fetchAudit(q: AuditQuery, signal?: AbortSignal): Promise<AuditResult> {
  if (import.meta.env.DEV) return (await import('./admin.dev')).auditMock(q);
  return apiFetch<AuditResult>(`/-/api/admin/audit${auditQueryString(q)}`, { signal, ...WIRE });
}
