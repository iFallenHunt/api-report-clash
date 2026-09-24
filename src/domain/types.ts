export type EventCategory =
  | 'season'
  | 'medal_event'
  | 'special_event'
  | 'challenge'
  | 'clan_games'
  | 'update'
  | 'cwl'
  | 'war'
  | 'raid_weekend'
  | 'cosmetic'
  | 'other';

/** Categorias que representam eventos com recompensas a conquistar (recebem pendência de revisão de prêmios). */
export const REWARD_CATEGORIES: ReadonlySet<EventCategory> = new Set(['season', 'medal_event', 'special_event', 'challenge', 'clan_games']);

export type EventScope = 'global' | 'clan';
export type DatePrecision = 'datetime' | 'date' | 'unknown';
export type EventStatus = 'announced' | 'scheduled' | 'active' | 'ended' | 'cancelled';
export type RewardsStatus = 'known' | 'not_announced' | 'unverified';
export type RewardTier = 'free' | 'paid' | 'unknown';

export interface Reward {
  label: string;
  quantity?: number | string;
  condition?: string;
  tier: RewardTier;
  /** Recompensas com o mesmo choiceGroup são opções entre as quais o jogador escolhe. */
  choiceGroup?: string;
  /**
   * "reward" (padrão): prêmio obtido ao cumprir a condição.
   * "shop": item trocável na loja do evento (não é prêmio garantido; custa a moeda do evento).
   */
  kind?: 'reward' | 'shop';
  /** Preço na loja, como publicado (ex.: "3.090 medalhas de missões"). */
  price?: string;
  /** Limite de compra na loja. */
  limit?: number;
}

export interface ClashEvent {
  id: string;
  canonicalKey: string | null;
  category: EventCategory;
  scope: EventScope;
  title: string;
  description: string | null;
  startAt: string | null;
  startPrecision: DatePrecision;
  endAt: string | null;
  endPrecision: DatePrecision;
  status: EventStatus;
  rewardsStatus: RewardsStatus;
  rewards: Reward[];
  primarySourceUrl: string | null;
  fieldLocks: string[];
  relevantRevision: number;
  firstSeenAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  extra: Record<string, unknown>;
}

/** Campos que, ao mudar, geram nova revisão relevante e possivelmente avisos. */
export const RELEVANT_FIELDS = [
  'title',
  'startAt',
  'startPrecision',
  'endAt',
  'endPrecision',
  'status',
  'rewardsStatus',
  'rewards',
  'category',
] as const;
export type RelevantField = (typeof RELEVANT_FIELDS)[number];

/** Campos que um coletor ou importação pode propor. */
export interface EventInput {
  id?: string;
  canonicalKey?: string | null;
  category: EventCategory;
  scope: EventScope;
  title: string;
  description?: string | null;
  startAt?: string | null;
  startPrecision?: DatePrecision;
  endAt?: string | null;
  endPrecision?: DatePrecision;
  status?: EventStatus;
  rewardsStatus?: RewardsStatus;
  rewards?: Reward[];
  primarySourceUrl?: string | null;
  extra?: Record<string, unknown>;
}

export const CATEGORY_LABEL: Record<EventCategory, string> = {
  season: 'Temporada',
  medal_event: 'Evento de medalhas',
  special_event: 'Evento especial',
  challenge: 'Desafio',
  clan_games: 'Jogos do Clã',
  update: 'Atualização',
  cwl: 'Liga de Guerra',
  war: 'Guerra de clãs',
  raid_weekend: 'Fim de Semana de Raides',
  cosmetic: 'Cosmético / loja',
  other: 'Evento',
};
