import { DurableObject } from 'cloudflare:workers';
import type { MessagingEvent, MessagingSocketServerMessage } from './messagingprotocol.js';
import type { Env } from './relay.js';

/**
 * WebSocket einer ELVIS-Installation fürs Cloud Messaging: genau ein Durable Object je ELW (idFromName(elwId)).
 * ELVIS baut die Verbindung ausgehend auf (kein offener Port im Fahrzeug nötig). Dank Hibernation API schläft das
 * Objekt, solange nichts passiert; den Keepalive ("ping" → "pong") beantwortet die Laufzeit, ohne es zu wecken.
 * Neue Ereignisse liegen bereits in D1 (messaging.ts) – das Objekt stößt ELVIS nur an; quittiert wird beim Abruf.
 */
export class ElwSocket extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** Upgrade (vom Worker nach Prüfung von Token und Signatur weitergereicht, Header x-elvis-elw = ELW-ID) */
  override async fetch(req: Request): Promise<Response> {
    const elwId = req.headers.get('x-elvis-elw');
    if (!elwId) return new Response('ELW fehlt', { status: 400 });
    const { 0: client, 1: server } = new WebSocketPair();
    // Ältere Verbindung derselben Installation (z. B. nach Netzwechsel) schließen – es gibt nur eine
    for (const ws of this.ctx.getWebSockets()) ws.close(4000, 'Neue Verbindung');
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: 'hello', elwId } satisfies MessagingSocketServerMessage));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Vom Worker per RPC: Ereignis an die verbundene Installation schicken */
  async notify(event: MessagingEvent): Promise<boolean> {
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) ws.send(JSON.stringify({ type: 'event', event } satisfies MessagingSocketServerMessage));
    return sockets.length > 0;
  }

  /** ELVIS schickt außer dem Keepalive (von der Laufzeit beantwortet) nichts */
  override async webSocketMessage(): Promise<void> {}

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'Tschüss');
    } catch {
      // bereits geschlossen
    }
  }
}
