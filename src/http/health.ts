import { createServer, type Server } from 'node:http';
import type { Logger } from '../logger.js';

/** Endpoint único GET /health para o healthcheck do Docker Compose. Sem autenticação, sem dados sensíveis. */
export function startHealthServer(port: number, status: () => Record<string, unknown>, log: Logger): Server | null {
  if (!port) return null;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      const body = JSON.stringify({ ok: true, ...status() });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, () => log.info({ port }, 'health endpoint ativo'));
  return server;
}
