/**
 * Cloud-Messaging-Protokoll zwischen Relay und ELVIS-Server (tel-diepholz/elvis).
 * Gegenstück in ELVIS: packages/shared/src/messagingrelay.ts – Änderungen dort und hier gleich halten.
 *
 * Installationen mit ELVIS-Postfach tragen sich mit ihrer Gebietskörperschaft ins Verzeichnis ein, finden sich dort und
 * chatten nach einer Anfrage, die die Gegenseite annimmt. Alle Inhalte (Anfrage, Nachrichten, Anhänge) verschlüsselt
 * ELVIS mit dem OpenPGP-Schlüssel des Postfachs der Gegenseite; das Relay sieht nur, wer wann wem schreibt.
 * Jeder Aufruf ist wie beim Mail-Abruf mit dem Ed25519-Schlüssel des Postfachs signiert (mailprotocol.ts).
 */
import { z } from 'zod';

export const MESSAGING_LIMITS = {
  /** Verschlüsselte Nachricht bzw. Anfrage (armored) */
  maxMessageBytes: 256 * 1024,
  /** Verschlüsselter Anhang */
  maxAttachmentBytes: 25 * 1024 * 1024,
  /** Treffer einer Verzeichnissuche */
  maxSearchResults: 50,
  /** Neue Anfragen je Stunde und Installation */
  requestsPerHour: 30,
  /** Nicht abgeholte Ereignisse und Anhänge werden danach gelöscht */
  retentionDays: 14,
} as const;

/** Amtlicher Regionalschlüssel: '' = Deutschland, 2 = Land, 5 = Kreis, 9 = Gemeindeverband, 12 = Gemeinde */
export const regionArsSchema = z.string().regex(/^(|\d{2}|\d{5}|\d{9}|\d{12})$/, 'Regionalschlüssel ungültig');

export type RegionKind = 'land' | 'kreis' | 'verband' | 'gemeinde';

export interface Region {
  ars: string;
  name: string;
  kind: RegionKind;
  /** Hat auswählbare Unterebenen */
  hasChildren: boolean;
}

/** Region mit ihrem Pfad von oben (ohne Deutschland), z. B. Niedersachsen › Landkreis Diepholz › Stuhr */
export interface RegionWithPath extends Region {
  path: Region[];
}

export const messagingContactSchema = z.object({
  kind: z.enum(['email', 'phone']),
  value: z.string().trim().min(1).max(254),
  label: z.string().trim().max(40).default(''),
});

export const messagingVehicleSchema = z.object({
  name: z.string().trim().min(1).max(40),
  callsign: z.string().trim().min(1).max(60),
  organization: z.string().trim().min(1).max(100),
  contacts: z.array(messagingContactSchema).max(20).default([]),
});
export type MessagingVehicle = z.infer<typeof messagingVehicleSchema>;

/** Eintrag im Verzeichnis anlegen oder ändern */
export const messagingProfileSchema = z.object({
  regionArs: regionArsSchema,
  vehicle: messagingVehicleSchema,
  /** Für andere auffindbar; nicht gelistete Installationen können trotzdem selbst anfragen */
  listed: z.boolean(),
});
export type MessagingProfileInput = z.input<typeof messagingProfileSchema>;

export interface DirectoryEntry {
  elwId: string;
  vehicle: MessagingVehicle;
  regionArs: string;
  /** Pfad der Region als Text, z. B. „Niedersachsen › Landkreis Diepholz › Stuhr“ */
  regionLabel: string;
  /** Postfachadresse der Installation */
  address: string;
  /** Öffentlicher OpenPGP-Schlüssel des Postfachs (armored) */
  publicKey: string;
  fingerprint: string;
  updatedAt: string;
}

export interface MessagingProfile extends DirectoryEntry {
  listed: boolean;
}

/** registered = im Verzeichnis; mailbox-missing = erst ein aktives ELVIS-Postfach einrichten */
export interface MessagingProfileStatus {
  status: 'none' | 'registered' | 'mailbox-missing';
  profile: MessagingProfile | null;
}

const ciphertext = z.string().min(1).max(MESSAGING_LIMITS.maxMessageBytes);
const id = z.string().uuid();

export const conversationRequestSchema = z.object({ to: id, ciphertext });
export const messageRequestSchema = z.object({ conversationId: id, ciphertext, attachmentId: id.nullable().default(null) });

/** requested: wartet auf Annahme · accepted · declined · closed (von einer Seite beendet) */
export type ConversationState = 'requested' | 'accepted' | 'declined' | 'closed';

export interface Conversation {
  id: string;
  /** Die andere Installation */
  peer: string;
  /** out: diese Installation hat angefragt */
  direction: 'in' | 'out';
  state: ConversationState;
  createdAt: string;
  updatedAt: string;
}

/**
 * Ereignis für eine Installation: request (neue Anfrage, ciphertext = verschlüsselte Anfrage), state (Status einer
 * Konversation geändert), message (ciphertext = verschlüsselter Umschlag, ggf. mit Anhang)
 */
export interface MessagingEvent {
  seq: number;
  type: 'request' | 'state' | 'message';
  conversationId: string;
  from: string;
  state: ConversationState;
  ciphertext: string | null;
  attachment: { id: string; size: number } | null;
  at: string;
}

export interface MessagingEventBatch {
  items: MessagingEvent[];
  /** Cursor für den nächsten Abruf; was bis dahin abgeholt ist, löscht das Relay */
  next: number;
}

/**
 * Über den WebSocket (Relay → ELVIS). Ein Ereignis ist der Anstoß, sofort GET …/events abzuholen: Pushes können sich
 * überholen, der Cursor des Abrufs hält die Reihenfolge und quittiert. ELVIS schickt nur den Keepalive "ping" (→ "pong").
 */
export type MessagingSocketServerMessage = { type: 'event'; event: MessagingEvent } | { type: 'hello'; elwId: string };
