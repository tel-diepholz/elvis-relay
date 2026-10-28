/** Gemeinsame Helfer für Antworten, Zufall und Hashes */

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...headers },
  });
export const fail = (status: number, error: string) => json(status, { error });

export const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
export const base64url = (b: Uint8Array) => {
  let bin = '';
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const fromBase64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
export const newToken = () => base64url(random(32));

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', (typeof data === 'string' ? new TextEncoder().encode(data) : data) as BufferSource));
}
/** Zugangsschlüssel werden nur als Hash gespeichert */
export const hash = (token: string) => sha256Hex(token);

export const bearer = (req: Request) => /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? null;

export async function body(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/** Gleichlange Zeichenketten in konstanter Zeit vergleichen */
export function sameCode(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
