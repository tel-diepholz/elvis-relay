/**
 * Protokoll zwischen App (tel-diepholz/elvis-app), Relay und ELVIS-Server (tel-diepholz/elvis).
 * Gegenstück in ELVIS: packages/shared/src/applink.ts – Änderungen dort und hier gleich halten.
 */
import { z } from 'zod';

// --- Geräte-ID und Code ---

/** Crockford-Base32 ohne I, L, O, U – gut vorzulesen und abzutippen */
export const DEVICE_ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const DEVICE_ID_LENGTH = 8;
export const PAIR_CODE_LENGTH = 6;

/** Eingabe vereinheitlichen: Groß-/Kleinschreibung, Leer- und Bindestriche egal, O→0, I/L→1 */
export function normalizeDeviceId(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

const deviceId = z
  .string()
  .transform(normalizeDeviceId)
  .refine((v) => v.length === DEVICE_ID_LENGTH && [...v].every((c) => DEVICE_ID_ALPHABET.includes(c)), 'App-ID ungültig (8 Zeichen, z. B. K7M2-QX9P)');
const pairCode = z
  .string()
  .transform((v) => v.replace(/\s/g, ''))
  .refine((v) => new RegExp(`^\\d{${PAIR_CODE_LENGTH}}$`).test(v), `Code ungültig (${PAIR_CODE_LENGTH} Ziffern)`);

// --- Relay-Protokoll ---

export const relayPositionSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  /** Genauigkeit in Metern (Radius), null = unbekannt */
  accuracyM: z.number().min(0).max(100_000).nullable(),
  /** Zeitpunkt der Ortung (ISO) */
  ts: z.string().datetime(),
  /** Akkustand 0…1, null = unbekannt */
  battery: z.number().min(0).max(1).nullable().default(null),
});
export type RelayPosition = z.output<typeof relayPositionSchema>;

/** Antwort an die App: Registrierung */
export interface DeviceRegistration {
  deviceId: string;
  token: string;
  code: string;
}

/** Antwort an die App: Zustand (auf jede Positionsmeldung und Statusabfrage) */
export interface DeviceStatus {
  paired: boolean;
  /** Vom ELW gesetzt, z. B. „HLF 20/1 · B3 Wohnungsbrand“ */
  label: string;
  /** Aktueller Code zum Koppeln, nur solange ungekoppelt */
  code: string | null;
}

export interface ElwRegistration {
  elwId: string;
  token: string;
}

export const relayPairSchema = z.object({ deviceId, code: pairCode, label: z.string().trim().max(200).default('') });
export type RelayPair = z.input<typeof relayPairSchema>;

export const relayLabelSchema = z.object({ label: z.string().trim().max(200) });

export interface RelayPositionItem extends RelayPosition {
  seq: number;
  deviceId: string;
}

/** Positionen für den ELW ab einem Cursor (seq) */
export interface ElwPositionBatch {
  items: RelayPositionItem[];
  /** Cursor für den nächsten Abruf */
  next: number;
}
