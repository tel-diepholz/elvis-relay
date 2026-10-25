import { cleanup, handle, internalError, type Env } from './relay.js';

// Einstieg des Workers: nur der Handler – weitere Exporte hält die Workers-Laufzeit für Entrypoints
export default {
  async fetch(req, env) {
    try {
      return await handle(req, env);
    } catch (e) {
      console.error(e);
      return internalError();
    }
  },
  async scheduled(_event, env) {
    await cleanup(env);
  },
} satisfies ExportedHandler<Env>;
