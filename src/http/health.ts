import { createServer, type Server } from 'node:http';
import type { Logger } from '../logger.js';

/**
 * Endpoint único GET /health para o healthcheck do Docker Compose. Sem autenticação, sem dados sensíveis.
 * HTTP 503 quando `status().ok === false` (ex.: WhatsApp pedindo QR, relatório agendado não entregue).
 */
export function startHealthServer(port: number, status: () => Record<string, unknown> & { ok?: boolean }, log: Logger): Server | null {
  if (!port) return null;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      const st = status();
      const ok = st.ok !== false;
      const body = JSON.stringify({ ...st, ok });
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, () => log.info({ port }, 'health endpoint ativo'));
  return server;
}
