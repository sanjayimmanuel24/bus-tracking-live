import { defineConfig } from 'vite';

/**
 * The dev server proxies the API and WebSocket to the backend so the browser sees
 * a single origin. That keeps CORS and WebSocket upgrade behaviour in development
 * the same as behind a reverse proxy in production, rather than working locally
 * and breaking on deploy.
 */
const API_TARGET = process.env['API_TARGET'] ?? 'http://127.0.0.1:3000';

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: API_TARGET, ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
});
