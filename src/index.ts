import { EmailMessage } from 'cloudflare:email';
import { receiveMail } from './mail.js';
import { cleanup, handle, internalError, type Env } from './relay.js';
import { ElwSocket } from './socket.js';
import { runStatusChecks } from './status.js';

/** Bindings aus wrangler.toml; SEND, NOTIFY und CONNECT baut index.ts daraus */
interface Bindings extends Omit<Env, 'SEND' | 'NOTIFY' | 'CONNECT'> {
  MAILER?: SendEmail;
  ELW_SOCKET?: DurableObjectNamespace<ElwSocket>;
}

/** Statusprüfung und Aufräumen je stündlich, versetzt (siehe wrangler.toml) */
const STATUS_CRON = '0 * * * *';

const socketOf = (env: Bindings, elwId: string) => env.ELW_SOCKET!.get(env.ELW_SOCKET!.idFromName(elwId));

const withMailer = (env: Bindings): Env => ({
  ...env,
  SEND: env.MAILER ? async (from, to, raw) => void (await env.MAILER!.send(new EmailMessage(from, to, raw))) : undefined,
  NOTIFY: env.ELW_SOCKET ? async (elwId, event) => void (await socketOf(env, elwId).notify(event)) : undefined,
  CONNECT: env.ELW_SOCKET
    ? async (elwId, req) => {
        const headers = new Headers(req.headers);
        headers.set('x-elvis-elw', elwId);
        return socketOf(env, elwId).fetch(new Request(req.url, { method: 'GET', headers }));
      }
    : undefined,
});

/** Durable Object der WebSockets fürs Cloud Messaging (wrangler.toml: ELW_SOCKET) */
export { ElwSocket };

// Einstieg des Workers: Handler plus die Klasse des Durable Objects
export default {
  async fetch(req, env) {
    try {
      return await handle(req, withMailer(env));
    } catch (e) {
      console.error(e);
      return internalError();
    }
  },
  async email(message, env) {
    await receiveMail(message, withMailer(env));
  },
  async scheduled(event, env) {
    if (event.cron === STATUS_CRON) await runStatusChecks(withMailer(env));
    else await cleanup(withMailer(env));
  },
} satisfies ExportedHandler<Bindings>;
