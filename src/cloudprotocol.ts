/**
 * Cloud-Zugang für die Datenpflege: Konten, Baustruktur, Einladungen, verknüpfte ELVIS-Installationen und deren Status.
 *
 * Zwei Seiten:
 * - **Portal** (cloud.einsatzleitwagen.app, `/v1/cloud/…`): Menschen mit Konto, angemeldet per E-Mail-Code, Sitzung als
 *   HttpOnly-Cookie.
 * - **ELVIS** (`/v1/elws/me/cloud…`): Bearer-Token der Installation plus Ed25519-Signatur wie beim Mail-Abruf
 *   (mailprotocol.ts), mit einem eigenen Schlüssel der Cloud-Verknüpfung.
 *
 * Der ELVIS-Teil (CLOUD_LINK_*, cloudLinkRequestSchema, CloudLinkStatus) hat sein Gegenstück in ELVIS:
 * packages/shared/src/cloudrelay.ts – Änderungen dort und hier gleich halten.
 */
import { z } from 'zod';
import type { RegionKind } from './messagingprotocol.js';

// --- ELVIS ↔ Relay ---

/** Verknüpfungscode: 8 Zeichen ohne Verwechsler, gilt eine Stunde */
export const CLOUD_LINK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CLOUD_LINK_CODE_LENGTH = 8;
export const CLOUD_LINK_TTL_MS = 3600_000;

export const cloudLinkRequestSchema = z.object({
  /** Name der Installation, wie er im Portal erscheint (Vorgabe: Fahrzeugname) */
  name: z.string().trim().min(1).max(80),
  /** Öffentlicher Ed25519-Schlüssel (raw, base64url); signiert schon diesen Aufruf */
  sigPublicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  version: z.string().max(40).default(''),
});
export type CloudLinkRequest = z.input<typeof cloudLinkRequestSchema>;

/** Knoten der Baustruktur, wie ELVIS ihn anzeigt: „Niedersachsen › Landkreis Diepholz › Gemeinde Weyhe“ */
export interface CloudNodeRef {
  id: string;
  name: string;
  /** Namen von oben nach unten, ohne Deutschland, inkl. des Knotens selbst */
  path: string[];
}

export type CloudLinkStatus =
  | { state: 'none' }
  | { state: 'pending'; code: string; expiresAt: string }
  | { state: 'linked'; node: CloudNodeRef; linkedAt: string; linkedBy: string };

// --- Portal ---

export const emailSchema = z.string().trim().toLowerCase().email('E-Mail-Adresse ungültig').max(200);

export const loginRequestSchema = z.object({ email: emailSchema });
export const loginVerifySchema = z.object({
  email: emailSchema,
  code: z.string().trim().regex(/^\d{6}$/, 'Code: 6 Ziffern'),
  /** Nur beim ersten Anmelden (neues Konto) */
  name: z.string().trim().max(80).optional(),
});

export const CLOUD_ROLES = ['viewer', 'editor', 'admin'] as const;
export type CloudRole = (typeof CLOUD_ROLES)[number];
export const CLOUD_ROLE_LABELS: Record<CloudRole, string> = { viewer: 'Lesen', editor: 'Pflegen', admin: 'Verwalten' };
export const roleRank = (r: CloudRole | null) => (r ? CLOUD_ROLES.indexOf(r) + 1 : 0);

export const SESSION_COOKIE = 'elvis_cloud';
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
export const LOGIN_CODE_TTL_MS = 15 * 60_000;
export const LOGIN_MAX_ATTEMPTS = 5;
/** Codes je Adresse und Stunde */
export const LOGIN_MAILS_PER_HOUR = 5;
export const INVITATION_TTL_MS = 14 * 24 * 3600_000;

export interface CloudAccount {
  id: string;
  email: string;
  name: string;
  /** Betreiber: darf Admins für jede Gebietskörperschaft einsetzen */
  operator: boolean;
}

export interface Membership {
  node: CloudNodeRef;
  role: CloudRole;
}

export interface Me extends CloudAccount {
  memberships: Membership[];
}

/** ARS-Knoten: id `ars:<Regionalschlüssel>` (Deutschland: `ars:`); freie Knoten: UUID */
export type NodeKind = RegionKind | 'country' | 'free';

export interface CloudNode {
  id: string;
  parentId: string | null;
  name: string;
  kind: NodeKind;
  ars: string | null;
  path: string[];
  /** IDs zu `path` (gleiche Reihenfolge) */
  pathIds: string[];
  /** Eigene Rolle hier (geerbt von oben oder direkt), null = keine */
  role: CloudRole | null;
}

export interface NodeDetail extends CloudNode {
  children: CloudNode[];
  members: { accountId: string; email: string; name: string; role: CloudRole; inherited: boolean; nodeName: string }[];
  invitations: { id: string; email: string; role: CloudRole; invitedBy: string; expiresAt: string }[];
}

export const freeNodeSchema = z.object({ parentId: z.string().min(1).max(60), name: z.string().trim().min(1, 'Name fehlt').max(80) });
export const renameNodeSchema = z.object({ name: z.string().trim().min(1, 'Name fehlt').max(80) });
export const invitationSchema = z.object({ nodeId: z.string().min(1).max(60), email: emailSchema, role: z.enum(CLOUD_ROLES) });
export const memberRoleSchema = z.object({ role: z.enum(CLOUD_ROLES) });
export const linkInstallationSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .transform((v) => v.replace(/[\s-]/g, ''))
    .refine((v) => v.length === CLOUD_LINK_CODE_LENGTH && [...v].every((c) => CLOUD_LINK_ALPHABET.includes(c)), 'Code ungültig'),
  nodeId: z.string().min(1).max(60),
});
export const moveInstallationSchema = z.object({ nodeId: z.string().min(1).max(60), name: z.string().trim().min(1).max(80).optional() });

/** Zustand der Cloud-Module einer Installation, aus dem, was das Relay ohnehin speichert */
export interface InstallationStatus {
  elwId: string;
  name: string;
  node: CloudNodeRef;
  version: string;
  linkedAt: string;
  linkedBy: string;
  /** Letzter Aufruf der Installation beim Relay */
  lastSeen: string | null;
  mail: {
    address: string;
    state: string;
    /** Mails, die auf die Abholung warten */
    waiting: number;
    waitingBytes: number;
    oldestWaiting: string | null;
    lastFetchAt: string | null;
    lastFetchCountry: string | null;
    sentToday: number;
  } | null;
  messaging: { listed: boolean; region: string; pendingEvents: number; openConversations: number } | null;
  app: { pairedDevices: number; pendingPositions: number; openForms: number; pendingSheets: number };
  hooks: { kinds: string[]; pendingEvents: number };
  backup: { count: number; bytes: number; lastAt: string | null } | null;
}

export interface InvitationInfo {
  email: string;
  node: CloudNodeRef;
  role: CloudRole;
  invitedBy: string;
  expired: boolean;
  accepted: boolean;
}
