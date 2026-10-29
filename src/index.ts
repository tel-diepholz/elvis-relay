import { EmailMessage } from 'cloudflare:email';
import { receiveMail } from './mail.js';
import { cleanup, handle, internalError, type Env } from './relay.js';
import { runStatusChecks } from './status.js';

/** Bindings aus wrangler.toml; SEND baut index.ts daraus */
interface Bindings extends Omit<Env, 'SEND'> {
  MAILER?: SendEmail;
}

/** Statusprüfung und Aufräumen je stündlich, versetzt (siehe wrangler.toml) */
const STATUS_CRON = '0 * * * *';

const withMailer = (env: Bindings): Env => ({
  ...env,
  SEND: env.MAILER ? async (from, to, raw) => void (await env.MAILER!.send(new EmailMessage(from, to, raw))) : undefined,
});

// Einstieg des Workers: nur der Handler – weitere Exporte hält die Workers-Laufzeit für Entrypoints
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
