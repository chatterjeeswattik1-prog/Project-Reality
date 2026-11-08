import { defineConfig, type Plugin, type ViteDevServer } from 'vite';

/**
 * Development: the Vercel Functions in api/ (multiplayer lobby and connection handshake) served by the dev server
 * itself, with their in-memory store (production uses Upstash Redis; see api/_store.ts).
 */
function devApi(): Plugin {
  return {
    name: 'dev-api',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const m = req.url?.match(/^\/api\/(lobby|signal)(\?.*)?$/);
        if (!m) return next();
        try {
          const mod = await server.ssrLoadModule(`/api/${m[1]}.ts`) as Record<string, (r: Request) => Promise<Response>>;
          const handler = mod[req.method ?? 'GET'];
          if (!handler) { res.statusCode = 405; res.end(); return; }
          const body = req.method === 'POST' ? await new Promise<string>((ok) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => ok(s)); }) : undefined;
          const r = await handler(new Request(`http://localhost${req.url}`, { method: req.method, body, headers: { 'content-type': 'application/json' } }));
          res.statusCode = r.status;
          r.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(await r.text());
        } catch (e) { res.statusCode = 500; res.end(String(e)); }
      });
    },
  };
}

export default defineConfig({
  plugins: [devApi()],
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ['@recast-navigation/wasm'] },
  server: { host: true },
});
