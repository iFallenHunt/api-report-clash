/**
 * Cliente mínimo da API oficial do Clash of Clans (https://developer.clashofclans.com).
 * - Autenticação: Bearer JWT criado no portal, vinculado a IPs públicos permitidos.
 * - Limite de requisições: não publicado; HTTP 429 ao exceder (respeitamos Retry-After).
 * - Endpoints usados: /clans/{tag}, /clans/{tag}/currentwar, /clans/{tag}/currentwar/leaguegroup,
 *   /clanwarleagues/wars/{warTag}, /clans/{tag}/capitalraidseasons.
 * Não existe endpoint de calendário, Jogos do Clã ou eventos especiais.
 */
export class CocApiError extends Error {
  constructor(readonly status: number, readonly reason: string, message: string) {
    super(message);
    this.name = 'CocApiError';
  }
  get isNotFound() {
    return this.status === 404;
  }
  get isForbidden() {
    return this.status === 403;
  }
}

export class CocUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'CocUnavailableError';
  }
}

export interface CocClientOptions {
  base: string;
  token: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function encodeTag(tag: string): string {
  const t = tag.trim().toUpperCase();
  return encodeURIComponent(t.startsWith('#') ? t : `#${t}`);
}

/** Datas da API: "20260924T170000.000Z" → ISO. */
export function parseCocTime(s: string | undefined | null): string | null {
  if (!s) return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d{3}))?Z$/.exec(s);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

export class CocClient {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: CocClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async get<T>(path: string): Promise<T> {
    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= this.maxRetries) {
      attempt++;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(`${this.opts.base}${path}`, {
          headers: { authorization: `Bearer ${this.opts.token}`, accept: 'application/json' },
          signal: ctrl.signal,
        });
        if (res.ok) return (await res.json()) as T;
        const body = (await res.json().catch(() => ({}))) as { reason?: string; message?: string };
        if (res.status === 429 || res.status >= 500) {
          lastErr = new CocApiError(res.status, body.reason ?? 'unknown', `HTTP ${res.status} ${body.message ?? ''}`.trim());
          const retryAfter = Number(res.headers.get('retry-after'));
          await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1));
          continue;
        }
        throw new CocApiError(res.status, body.reason ?? 'unknown', `HTTP ${res.status} ${body.reason ?? ''} ${body.message ?? ''}`.trim());
      } catch (err) {
        if (err instanceof CocApiError) throw err;
        lastErr = err;
        await this.sleep(1000 * 2 ** (attempt - 1));
      } finally {
        clearTimeout(t);
      }
    }
    throw new CocUnavailableError(`API do Clash indisponível após ${attempt} tentativas: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`, lastErr);
  }

  clan(tag: string) {
    return this.get<{ name: string; tag: string; isWarLogPublic?: boolean; members?: number }>(`/clans/${encodeTag(tag)}`);
  }
  currentWar(tag: string) {
    return this.get<RawWar>(`/clans/${encodeTag(tag)}/currentwar`);
  }
  leagueGroup(tag: string) {
    return this.get<RawLeagueGroup>(`/clans/${encodeTag(tag)}/currentwar/leaguegroup`);
  }
  leagueWar(warTag: string) {
    return this.get<RawWar>(`/clanwarleagues/wars/${encodeTag(warTag)}`);
  }
  capitalRaidSeasons(tag: string, limit = 1) {
    return this.get<{ items: RawRaidSeason[] }>(`/clans/${encodeTag(tag)}/capitalraidseasons?limit=${limit}`);
  }
}

export interface RawWarClan {
  tag?: string;
  name?: string;
  stars?: number;
  destructionPercentage?: number;
  attacks?: number;
}
export interface RawWar {
  state: 'notInWar' | 'preparation' | 'inWar' | 'warEnded';
  teamSize?: number;
  attacksPerMember?: number;
  preparationStartTime?: string;
  startTime?: string;
  endTime?: string;
  clan?: RawWarClan;
  opponent?: RawWarClan;
}
export interface RawLeagueGroup {
  state: 'preparation' | 'inWar' | 'ended' | 'notInWar';
  season: string;
  clans?: { tag: string; name: string }[];
  rounds?: { warTags: string[] }[];
}
export interface RawRaidSeason {
  state: 'ongoing' | 'ended';
  startTime: string;
  endTime: string;
  capitalTotalLoot?: number;
  raidsCompleted?: number;
  totalAttacks?: number;
  enemyDistrictsDestroyed?: number;
  offensiveReward?: number;
  defensiveReward?: number;
}
