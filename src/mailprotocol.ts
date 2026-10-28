/**
 * Mail-Protokoll zwischen Relay und ELVIS-Server (tel-diepholz/elvis).
 * Gegenstück in ELVIS: packages/shared/src/mailrelay.ts – Änderungen dort und hier gleich halten.
 */
import { z } from 'zod';

/** Adressteil vor dem @: 3–40 Zeichen, Kleinbuchstaben, Ziffern, Punkt und Bindestrich, nicht am Rand */
export const MAIL_LOCALPART_RE = /^[a-z0-9][a-z0-9.-]{1,38}[a-z0-9]$/;
/** Nicht vergebbar: Rollenadressen und Adressen des Relays selbst */
export const RESERVED_LOCALPARTS = [
  'abuse', 'admin', 'administrator', 'elvis', 'hostmaster', 'info', 'mail', 'mailer-daemon', 'no-reply', 'noreply',
  'openpgpkey', 'postmaster', 'probe', 'relay', 'root', 'security', 'status', 'support', 'webmaster',
];

export const MAIL_LIMITS = {
  /** Empfänger je Mail */
  maxRecipients: 50,
  /** Mails je Stunde und Postfach (Empfänger zählen einzeln) */
  perHour: 60,
  /** Mails je Tag und Postfach (Empfänger zählen einzeln) */
  perDay: 300,
  /** Größe einer Rohmail (ein- und ausgehend) */
  maxBytes: 25 * 1024 * 1024,
} as const;

/** Header signierter Mail-Abrufe: `t=<Unix-ms>,n=<Nonce>,s=<Ed25519-Signatur base64url>` */
export const MAIL_SIGNATURE_HEADER = 'x-elvis-signature';
/** Zulässige Abweichung der Uhr des ELW */
export const MAIL_SIGNATURE_WINDOW_MS = 5 * 60_000;

/** Was signiert wird: Methode, Pfad mit Query, SHA-256 des Körpers (hex), Zeit, Nonce */
export const mailSignaturePayload = (method: string, pathAndQuery: string, bodySha256Hex: string, t: number, nonce: string) =>
  `${method.toUpperCase()}\n${pathAndQuery}\n${bodySha256Hex}\n${t}\n${nonce}`;

const localpart = z
  .string()
  .trim()
  .toLowerCase()
  .refine((v) => MAIL_LOCALPART_RE.test(v), 'Adresse ungültig (3–40 Zeichen: a–z, 0–9, Punkt, Bindestrich)')
  .refine((v) => !RESERVED_LOCALPARTS.includes(v), 'Diese Adresse ist reserviert');

/** Ed25519-Schlüssel (32 Byte, base64url) */
const sigPublicKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Signaturschlüssel ungültig');

export const mailboxRequestSchema = z.object({
  localpart,
  adminEmail: z.string().trim().toLowerCase().email('Admin-Adresse ungültig').max(254),
  /** Öffentlicher OpenPGP-Schlüssel (armored), User-ID = Postfachadresse */
  publicKey: z.string().min(100).max(20_000),
  /** Widerrufszertifikat (armored) – geht mit der Schlüssel-Mail an den Admin und wird danach gelöscht */
  revocationCert: z.string().min(100).max(10_000),
  sigPublicKey,
});
export type MailboxRequest = z.input<typeof mailboxRequestSchema>;

/**
 * none: kein Postfach · pending: Bestätigungslink offen · approval: wartet auf Freigabe ·
 * active · rebind-pending: Übernahme durch diese Installation beantragt · moved: an eine andere Installation übertragen
 */
export type MailboxState = 'none' | 'pending' | 'approval' | 'active' | 'rebind-pending' | 'moved';

export interface MailboxStatus {
  status: MailboxState;
  address: string | null;
  fingerprint: string | null;
  adminEmail: string | null;
  activatedAt: string | null;
  keysMailedAt: string | null;
  lastFetchAt: string | null;
  lastFetchCountry: string | null;
}

export interface RelayMailItem {
  seq: number;
  size: number;
  receivedAt: string;
}

export interface RelayMailBatch {
  items: RelayMailItem[];
  /** Cursor für den nächsten Abruf; alles bis einschließlich wird dabei gelöscht */
  next: number;
}

export const mailOutboxSchema = z.object({
  /** Umschlag-Empfänger (inkl. Bcc; der Bcc-Header ist nicht in der Rohmail) */
  to: z.array(z.string().trim().toLowerCase().email()).min(1).max(MAIL_LIMITS.maxRecipients),
  /** Rohmail (RFC 5322), base64 */
  raw: z.string().min(1).max(Math.ceil((MAIL_LIMITS.maxBytes * 4) / 3) + 4),
});
export type MailOutbox = z.input<typeof mailOutboxSchema>;

export interface MailOutboxResult {
  sent: number;
}

// --- Statusseite ---

export type StatusLevel = 'ok' | 'degraded' | 'outage';
export const STATUS_COMPONENTS = [
  { id: 'inbound', label: 'Mail-Empfang' },
  { id: 'outbound', label: 'Mail-Versand' },
  { id: 'storage', label: 'Zustellung an ELVIS' },
  { id: 'api', label: 'Relay-API' },
  { id: 'db', label: 'Datenbank (App-Ortung, Personalbögen)' },
] as const;
export type StatusComponentId = (typeof STATUS_COMPONENTS)[number]['id'];

export interface StatusIncident {
  id: number;
  title: string;
  body: string;
  severity: 'info' | StatusLevel;
  components: StatusComponentId[];
  startedAt: string;
  resolvedAt: string | null;
}

export interface RelayStatus {
  overall: StatusLevel;
  checkedAt: string | null;
  components: { id: StatusComponentId; label: string; status: StatusLevel; lastCheck: string | null; detail: string }[];
  /** Je Komponente die letzten 90 Tage, Anteil erfolgreicher Prüfungen (null = keine Daten) */
  uptime: Record<StatusComponentId, { day: string; ok: number | null }[]>;
  incidents: StatusIncident[];
}

export const statusIncidentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().max(5000).default(''),
  severity: z.enum(['info', 'degraded', 'outage']),
  components: z.array(z.enum(['inbound', 'outbound', 'storage', 'api', 'db'])).default([]),
});
export const statusIncidentPatchSchema = statusIncidentSchema.partial().extend({ resolved: z.boolean().optional() });
