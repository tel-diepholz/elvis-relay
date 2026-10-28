/** Kleine MIME-Erzeugung für die Mails, die das Relay selbst schickt (Bestätigung, Schlüssel, Status) */

export interface MimeAttachment {
  filename: string;
  contentType: string;
  content: string;
}

export interface MimeMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  attachments?: MimeAttachment[];
  headers?: Record<string, string>;
  date?: Date;
}

const utf8 = new TextEncoder();
const base64 = (s: string) => {
  const bytes = utf8.encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
/** Base64 in Zeilen zu 76 Zeichen (RFC 2045) */
const wrapped = (s: string) => base64(s).replace(/.{76}(?=.)/g, '$&\r\n');
/** Kopfzeile mit Umlauten als encoded word (RFC 2047) */
export const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${base64(s)}?=`);

const randomId = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');

export function buildMime(mail: MimeMail): string {
  const domain = addressOf(mail.from).split('@')[1] ?? 'localhost';
  const head = [
    `From: ${mail.from}`,
    `To: ${mail.to}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    `Date: ${(mail.date ?? new Date()).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomId()}@${domain}>`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
    ...Object.entries(mail.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
  ];
  const textPart = ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrapped(mail.text)];
  if (!mail.attachments?.length) return [...head, ...textPart, ''].join('\r\n');

  const boundary = `elvis-${randomId()}`;
  const parts = [
    textPart.join('\r\n'),
    ...mail.attachments.map((a) =>
      [
        `Content-Type: ${a.contentType}; name="${a.filename}"`,
        `Content-Disposition: attachment; filename="${a.filename}"`,
        'Content-Transfer-Encoding: base64',
        '',
        wrapped(a.content),
      ].join('\r\n'),
    ),
  ];
  return [
    ...head,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    ...parts.map((p) => `--${boundary}\r\n${p}`),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/** Wert einer Kopfzeile aus einer Rohmail (nur der Kopf bis zur ersten Leerzeile, gefaltete Zeilen zusammengefügt) */
export function headerValue(raw: string, name: string): string | null {
  const end = raw.search(/\r?\n\r?\n/);
  const head = (end < 0 ? raw : raw.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ');
  const re = new RegExp(`^${name}:[ \\t]*(.*)$`, 'im');
  return re.exec(head)?.[1]?.trim() ?? null;
}

/** Adresse aus „Name <a@b>“ oder „a@b“ */
export const addressOf = (value: string) => (/<([^>]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase();
