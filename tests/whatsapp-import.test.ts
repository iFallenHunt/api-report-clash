import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Regressão: "LocalAuth is not a constructor".
 * O Vitest aplica a própria interop de CommonJS (expõe exports nomeados que o Node não expõe), então o
 * teste roda num processo Node real, com o mesmo loader do `npm run` (tsx). Não inicia o navegador.
 */
const root = join(import.meta.dirname, '..');
function runNode(code: string): string {
  return execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: root, encoding: 'utf8' }).trim();
}

describe('carregamento do whatsapp-web.js em Node real (CommonJS importado de ESM)', () => {
  it('causa: no Node, o namespace ESM do pacote só traz Client como export nomeado', () => {
    const out = runNode(`const m = await import('whatsapp-web.js'); console.log(typeof m.Client, typeof m.LocalAuth, typeof m.default.LocalAuth)`);
    expect(out).toBe('function undefined function');
  });

  it('correção: loadWhatsAppWeb() entrega Client e LocalAuth construtíveis', () => {
    const mod = pathToFileURL(join(root, 'src', 'whatsapp', 'client.ts')).href;
    const out = runNode(
      `const { loadWhatsAppWeb } = await import(${JSON.stringify(mod)});
       const { Client, LocalAuth } = await loadWhatsAppWeb();
       const a = new LocalAuth({ clientId: 'clash-report-bot', dataPath: './wa-session-nao-criada' });
       console.log(typeof Client, typeof LocalAuth, a instanceof LocalAuth)`,
    );
    expect(out).toBe('function function true');
  });
});
