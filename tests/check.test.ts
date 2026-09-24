import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCheck } from '../src/cli/check.js';
import { testConfig } from '../src/config.js';

afterEach(() => vi.unstubAllGlobals());

describe('diagnóstico (check)', () => {
  it('nunca imprime o token e explica 403 de IP não autorizado', async () => {
    const out: string[] = [];
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ reason: 'accessDenied.invalidIp', message: 'API key does not allow access from IP 203.0.113.7' }), { status: 403 }));
    const cfg = testConfig();
    const ok = await runCheck({ ...cfg, coc: { ...cfg.coc, token: 'SEGREDO-NAO-IMPRIMIR', clanTag: '#ABC' } }, (s) => out.push(s));
    const text = out.join('\n');
    expect(ok).toBe(false);
    expect(text).not.toContain('SEGREDO-NAO-IMPRIMIR');
    expect(text).toContain('valor não exibido');
    expect(text).toMatch(/403.*IP de saída não autorizado.*203\.0\.113\.7/);
  });

  it('sem credenciais apenas informa, sem consultar a API', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const out: string[] = [];
    expect(await runCheck(testConfig(), (s) => out.push(s))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.join('\n')).toContain('COC_API_TOKEN ausente');
  });
});
