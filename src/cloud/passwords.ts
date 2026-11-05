import { base64url, fromBase64url, random, sameCode } from '../http.js';

/**
 * Passwörter des Cloud-Portals: PBKDF2-SHA256 mit zufälligem Salz je Konto (WebCrypto, im Worker ohne Zusatzpaket).
 * 100.000 Runden sind das Höchste, was Workers für PBKDF2 zulassen. Gespeichert wird
 * `pbkdf2-sha256$<Runden>$<Salz>$<Hash>`, so lassen sich die Runden später erhöhen, ohne alte Hashes zu brechen.
 */
const ITERATIONS = 100_000;
const PREFIX = 'pbkdf2-sha256';

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = random(16);
  return `${PREFIX}$${ITERATIONS}$${base64url(salt)}$${base64url(await derive(password, salt, ITERATIONS))}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [prefix, iter, salt, expected] = (stored ?? '').split('$');
  if (prefix !== PREFIX || !iter || !salt || !expected) {
    // Ohne gespeichertes Passwort trotzdem rechnen – die Antwortzeit verrät nicht, ob es das Konto gibt
    await derive(password, random(16), ITERATIONS);
    return false;
  }
  return sameCode(base64url(await derive(password, fromBase64url(salt), Number(iter))), expected);
}
