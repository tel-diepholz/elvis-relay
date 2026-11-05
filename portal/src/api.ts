import type { CloudRole, InstallationStatus, InvitationInfo, Me, NodeDetail } from '../../src/cloudprotocol';

export type { CloudNode, CloudRole, InstallationStatus, InvitationInfo, Me, NodeDetail } from '../../src/cloudprotocol';

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
  login: (email: string) => request<{ ok: true }>('POST', '/v1/cloud/login', { email }),
  verify: (email: string, code: string, name?: string) => request<Me>('POST', '/v1/cloud/login/verify', { email, code, name }),
  logout: () => request<null>('POST', '/v1/cloud/logout', {}),

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

  installations: () => request<InstallationStatus[]>('GET', '/v1/cloud/installations'),
  link: (code: string, nodeId: string) => request<InstallationStatus>('POST', '/v1/cloud/installations', { code, nodeId }),
  moveInstallation: (elwId: string, nodeId: string, name?: string) => request<InstallationStatus>('PUT', `/v1/cloud/installations/${elwId}`, { nodeId, name }),
  unlink: (elwId: string) => request<null>('DELETE', `/v1/cloud/installations/${elwId}`),
};
