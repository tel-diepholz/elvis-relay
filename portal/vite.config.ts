import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Lokal: `npm run dev` im Relay (wrangler dev, :8787) und hier `npm run dev` – die API läuft über den Proxy, damit
// Cookie und Origin wie im Betrieb auf derselben Adresse liegen.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, proxy: { '/v1': { target: process.env.RELAY_URL ?? 'http://localhost:8787', changeOrigin: false } } },
});
