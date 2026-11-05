import type { FireboardLibrary } from '../../src/fireboardprotocol';
import type { AdminAccount, AdminLogEntry, AdminOverview, CloudRole, InstallationStatus, InvitationInfo, Me, NodeDetail } from '../../src/cloudprotocol';
import type { PortalRecord, RecordDataMap, RecordKind } from '../../src/syncprotocol';

export type { PortalRecord, RecordDataMap, RecordKind } from '../../src/syncprotocol';

export type { AdminAccount, AdminLogEntry, AdminOverview, CloudNode, CloudNodeRef, CloudRole, InstallationStatus, InvitationInfo, Me, NodeDetail } from '../../src/cloudprotocol';

export const ROLE_LABELS: Record<CloudRole, string> = { viewer: 'Lesen', editor: 'Pflegen', admin: 'Verwalten' };
export const ROLE_HINTS: Record<CloudRole, string> = {
  viewer: 'sieht Stammdaten und den Status der Installationen',
  editor: 'pflegt Stammdaten',
  admin: 'pflegt Stammdaten, lädt ein, verknüpft Installationen, legt Unterknoten an',
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `Fehler ${res.status}`);
  return data as T;
}

const node = (id: string) => `/v1/cloud/nodes/${encodeURIComponent(id)}`;

export const api = {
  me: () => request<Me>('GET', '/v1/cloud/me'),
  rename: (name: string) => request<Me>('PATCH', '/v1/cloud/me', { name }),
  /** 202 { verify: true } = Bestätigungsmail unterwegs; mit gültiger Einladung direkt angemeldet (Me) */
  register: (email: string, name: string, password: string, invitation?: string) => request<Me | { verify: true }>('POST', '/v1/cloud/register', { email, name, password, invitation }),
  login: (email: string, password: string) => request<Me>('POST', '/v1/cloud/login', { email, password }),
  verify: (token: string) => request<Me>('POST', '/v1/cloud/verify', { token }),
  resendVerify: (email: string) => request<{ ok: true }>('POST', '/v1/cloud/verify/resend', { email }),
  forgotPassword: (email: string) => request<{ ok: true }>('POST', '/v1/cloud/password/forgot', { email }),
  resetPassword: (token: string, password: string) => request<Me>('POST', '/v1/cloud/password/reset', { token, password }),
  changePassword: (current: string, password: string) => request<{ ok: true }>('POST', '/v1/cloud/password', { current, password }),
  changeEmail: (email: string, password: string) => request<{ email: string }>('POST', '/v1/cloud/email', { email, password }),
  confirmEmail: (token: string) => request<{ email: string }>('POST', '/v1/cloud/email/confirm', { token }),
  logoutOthers: () => request<{ ended: number }>('POST', '/v1/cloud/logout/others', {}),
  deleteAccount: (password: string) => request<null>('DELETE', '/v1/cloud/me', { password }),
  logout: () => request<null>('POST', '/v1/cloud/logout', {}),
  // Verwaltung (nur Betreiber)
  adminOverview: (q = '') => request<AdminOverview>('GET', `/v1/cloud/admin${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  adminLog: () => request<AdminLogEntry[]>('GET', '/v1/cloud/admin/log'),
  adminPatch: (id: string, patch: { name?: string; email?: string; operator?: boolean; disabled?: boolean }) => request<AdminAccount>('PATCH', `/v1/cloud/admin/accounts/${id}`, patch),
  adminAction: (id: string, action: 'reset-link' | 'verify' | 'unlock' | 'logout') => request<AdminAccount>('POST', `/v1/cloud/admin/accounts/${id}/${action}`, {}),
  adminMembership: (id: string, nodeId: string, role: CloudRole | null) => request<AdminAccount>('PUT', `/v1/cloud/admin/accounts/${id}/membership`, { nodeId, role }),
  adminDelete: (id: string) => request<null>('DELETE', `/v1/cloud/admin/accounts/${id}`),

  node: (id: string) => request<NodeDetail>('GET', node(id)),
  createNode: (parentId: string, name: string) => request<NodeDetail>('POST', '/v1/cloud/nodes', { parentId, name }),
  renameNode: (id: string, name: string) => request<NodeDetail>('PATCH', node(id), { name }),
  removeNode: (id: string) => request<null>('DELETE', node(id)),
  setRole: (nodeId: string, accountId: string, role: CloudRole) => request<unknown>('PUT', `${node(nodeId)}/members/${accountId}`, { role }),
  removeMember: (nodeId: string, accountId: string) => request<null>('DELETE', `${node(nodeId)}/members/${accountId}`),

  invite: (nodeId: string, email: string, role: CloudRole) => request<unknown>('POST', '/v1/cloud/invitations', { nodeId, email, role }),
  cancelInvitation: (id: string) => request<null>('DELETE', `/v1/cloud/invitations/${id}`),
  invitation: (token: string) => request<InvitationInfo>('GET', `/v1/cloud/invitations/token/${token}`),
  acceptInvitation: (token: string) => request<Me>('POST', `/v1/cloud/invitations/token/${token}/accept`, {}),

  records: <K extends RecordKind>(nodeId: string, kind: K) => request<(PortalRecord & { data: RecordDataMap[K] })[]>('GET', `${node(nodeId)}/records?kind=${kind}`),
  createRecord: <K extends RecordKind>(nodeId: string, kind: K, data: RecordDataMap[K]) => request<PortalRecord>('POST', '/v1/cloud/records', { nodeId, kind, data }),
  updateRecord: <K extends RecordKind>(uid: string, baseRev: number, data: RecordDataMap[K]) => request<PortalRecord>('PUT', `/v1/cloud/records/${uid}`, { baseRev, data }),
  createRecordWithUid: <K extends RecordKind>(nodeId: string, kind: K, uid: string, data: RecordDataMap[K]) => request<PortalRecord>('POST', '/v1/cloud/records', { nodeId, kind, uid, data }),
  fireboard: (nodeId: string, email: string, password: string) => request<FireboardLibrary>('POST', '/v1/cloud/import/fireboard', { nodeId, email, password }),
  importRecords: <K extends RecordKind>(nodeId: string, kind: K, items: RecordDataMap[K][]) => request<{ created: number; errors: { index: number; reason: string }[] }>('POST', '/v1/cloud/records/batch', { nodeId, kind, items }),
  removeRecord: (uid: string, rev: number) => request<null>('DELETE', `/v1/cloud/records/${uid}?rev=${rev}`),

  installations: () => request<InstallationStatus[]>('GET', '/v1/cloud/installations'),
  link: (code: string, nodeId: string) => request<InstallationStatus>('POST', '/v1/cloud/installations', { code, nodeId }),
  moveInstallation: (elwId: string, nodeId: string, name?: string) => request<InstallationStatus>('PUT', `/v1/cloud/installations/${elwId}`, { nodeId, name }),
  unlink: (elwId: string) => request<null>('DELETE', `/v1/cloud/installations/${elwId}`),
};
