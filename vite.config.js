import { defineConfig, loadEnv } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { Readable } from 'node:stream';

// Local CORS helper: /proxy/https/example.com/path/model.glb -> https://example.com/path/model.glb
// The scheme and host live in the path so relative resources (.bin, textures, .mtl) resolve
// naturally. Only exists under `vite` / `vite preview`; a static deployment has no proxy.
function corsProxy() {
  const handler = async (req, res, next) => {
    const m = /^\/proxy\/(https?)\/([^/]+)(\/.*)?$/.exec(req.url || '');
    if (!m) return next();
    const target = `${m[1]}://${m[2]}${m[3] || '/'}`;
    try {
      const upstream = await fetch(target, {
        redirect: 'follow',
        // Some file hosts refuse requests without a browser-like user agent.
        headers: { ...(req.headers.range ? { range: req.headers.range } : {}), 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', accept: '*/*' },
      });
      res.setHeader('x-model-proxy', '1');
      res.statusCode = upstream.status;
      // Range support lets <video> seek through proxied files.
      for (const h of ['content-type', 'content-length', 'content-disposition', 'content-range', 'accept-ranges']) {
        const v = upstream.headers.get(h);
        // content-length is only valid if the body wasn't transparently decompressed
        if (v && !(h === 'content-length' && upstream.headers.get('content-encoding'))) {
          res.setHeader(h, v);
        }
      }
      res.setHeader('access-control-allow-origin', '*');
      if (!upstream.body) return res.end();
      Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
    } catch (err) {
      res.setHeader('x-model-proxy', '1');
      res.statusCode = 502;
      res.end(`Proxy error: ${err.message}`);
    }
  };
  return {
    name: 'cors-proxy',
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

export default defineConfig(({ mode }) => {
  // Machine-specific dev settings live in .env.local, which git ignores (see .env.example).
  const env = loadEnv(mode, process.cwd(), 'DEV_');
  // Extra host names the dev / preview server should answer to, comma separated.
  const hosts = (env.DEV_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
  return {
    // Self-signed HTTPS: WebHID (head tracking) needs a secure context when not on localhost.
    plugins: [basicSsl({ domains: [...hosts, 'localhost'] }), corsProxy()],
    server: { host: true, allowedHosts: hosts },
    preview: { host: true, allowedHosts: hosts },
    build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
    optimizeDeps: { exclude: ['@sparkjsdev/spark'] },
  };
});
