// Game detection through spectator-v5 (r=riot/active-game), only once the game has started: enemy
// accounts are hidden during a ranked champion select and are never looked up before.
// Strict Riot call budget: ≤ MAX_ACTIVE_GAME_CHECKS spectator calls, then 2 calls per enemy
// (rank + masteries), the enrichment being cached per game id.
import type { ChampionCatalog } from '../engine';
import type { DraftAllySlot, DraftEnemyAccount, DraftEnemySlot, DraftState, MasteryEntry } from './types';
import { ApiError } from './backend';
import { DRAFT_SIZE, MAX_BANS } from './draft';
import { mapMasteries, pickRank, riotGet, type RawLeagueEntry, type RawMastery, type RiotTransport } from './riot';

export const MAX_ACTIVE_GAME_CHECKS = 2;
export const ENEMY_MASTERY_COUNT = 20;
/** Upper bound of Riot calls for one detection (2 spectator checks + 5 enemies × 2). */
export const RIOT_CALL_BUDGET = MAX_ACTIVE_GAME_CHECKS + DRAFT_SIZE * 2;

export const NO_ACTIVE_GAME = 'Aucune partie en cours pour ces joueurs (la détection ne marche qu’une fois l’écran de chargement lancé).';

export interface RawSpectatorParticipant {
  puuid?: string | null;
  teamId?: number;
  championId?: number;
  riotId?: string;
}

export interface RawActiveGame {
  gameId?: number;
  gameQueueConfigId?: number;
  platformId?: string;
  participants?: RawSpectatorParticipant[];
  bannedChampions?: { championId?: number; teamId?: number; pickTurn?: number }[];
}

export interface DetectFriend {
  player_id: string;
  puuid?: string | null;
  platform: string;
}

export interface DetectedGame {
  game_id: number;
  queue_id: number | null;
  side: 'blue' | 'red' | null;
  ally: DraftAllySlot[];
  enemy: DraftEnemySlot[];
  ally_bans: string[];
  enemy_bans: string[];
  enemy_accounts: DraftEnemyAccount[];
}

type Catalog = { get: ChampionCatalog['get']; byKey: ChampionCatalog['byKey'] };

/** Enemy accounts already enriched, per game id (one enrichment per game and page load). */
const enrichmentCache = new Map<number, DraftEnemyAccount[]>();

/** Tests only. */
export function resetSpectatorForTests(): void {
  enrichmentCache.clear();
}

export interface DetectOptions {
  transport?: RiotTransport;
  /** Every site player (puuid → player id) to recognise friends who are not in the draft. */
  knownPlayers?: { id: string; puuid?: string | null }[];
  /** Enemy accounts already known for a game id (e.g. stored in the draft document). */
  known?: { game_id: number | null | undefined; accounts: DraftEnemyAccount[] | undefined };
}

const isNotFound = (err: unknown) => err instanceof ApiError && err.status === 404;

/** Wraps riotGet with a hard call counter. */
class Budget {
  calls = 0;
  constructor(private readonly max: number, private readonly t?: RiotTransport) {}
  get remaining() {
    return this.max - this.calls;
  }
  async get<T>(endpoint: string, params: Record<string, string | number>): Promise<T> {
    if (this.calls >= this.max) throw new ApiError('Budget d’appels Riot dépassé.', 429);
    this.calls += 1;
    return riotGet<T>(endpoint, params, this.t);
  }
}

/**
 * Looks for the running game of the draft's friends (first found wins). null = no game ("Aucune
 * partie en cours"); other errors (key missing, rate limit) are thrown.
 */
export async function detectActiveGame(
  friends: DetectFriend[],
  catalog: Catalog,
  options: DetectOptions = {},
): Promise<{ game: DetectedGame; calls: number } | null> {
  const budget = new Budget(RIOT_CALL_BUDGET, options.transport);
  const candidates = friends.filter((f) => f.puuid).slice(0, MAX_ACTIVE_GAME_CHECKS);
  let raw: RawActiveGame | null = null;
  let found: DetectFriend | null = null;
  for (const f of candidates) {
    try {
      raw = await budget.get<RawActiveGame>('active-game', { platform: f.platform, puuid: f.puuid as string });
      found = f;
      break;
    } catch (err) {
      if (isNotFound(err)) continue;
      throw err;
    }
  }
  if (!raw || !found || typeof raw.gameId !== 'number') return null;

  const participants = (raw.participants ?? []).filter((p) => p && typeof p === 'object');
  const me = participants.find((p) => p.puuid === found!.puuid);
  const ourTeam = me?.teamId ?? 100;
  const champ = (key: unknown) => {
    const k = Number(key);
    return Number.isFinite(k) && k > 0 ? catalog.byKey(k)?.id ?? null : null;
  };
  const byPuuid = new Map<string, string>();
  for (const p of options.knownPlayers ?? []) if (p.puuid) byPuuid.set(p.puuid, p.id);
  for (const f of friends) if (f.puuid) byPuuid.set(f.puuid, f.player_id);

  const allies = participants.filter((p) => p.teamId === ourTeam).slice(0, DRAFT_SIZE);
  const enemies = participants.filter((p) => p.teamId !== ourTeam).slice(0, DRAFT_SIZE);
  const ally: DraftAllySlot[] = allies.map((p) => ({
    player_id: (p.puuid && byPuuid.get(p.puuid)) || null,
    champion_id: champ(p.championId),
    role: null,
    locked: true,
  }));
  // The game has started: enemy accounts are public now (spectator), the slot keeps their puuid.
  const enemy: DraftEnemySlot[] = enemies.map((p) => ({ champion_id: champ(p.championId), role: null, locked: true, ...(p.puuid ? { puuid: p.puuid } : {}) }));
  const bans = (mine: boolean) =>
    Array.from(new Set((raw!.bannedChampions ?? [])
      .filter((b) => (b.teamId === ourTeam) === mine)
      .map((b) => champ(b.championId))
      .filter((c): c is string => !!c))).slice(0, MAX_BANS);

  const gameId = raw.gameId;
  let accounts = enrichmentCache.get(gameId);
  if (!accounts && options.known?.game_id === gameId && options.known.accounts?.length) accounts = options.known.accounts;
  if (!accounts) {
    accounts = await enrichEnemies(enemies, found.platform, catalog, budget);
    enrichmentCache.set(gameId, accounts);
  }

  return {
    game: {
      game_id: gameId,
      queue_id: typeof raw.gameQueueConfigId === 'number' ? raw.gameQueueConfigId : null,
      side: ourTeam === 200 ? 'red' : 'blue',
      ally,
      enemy,
      ally_bans: bans(true),
      enemy_bans: bans(false),
      enemy_accounts: accounts,
    },
    calls: budget.calls,
  };
}

/** Rank + top masteries of each enemy (2 calls each, within the budget; failures degrade to unknown). */
async function enrichEnemies(
  enemies: RawSpectatorParticipant[],
  platform: string,
  catalog: Catalog,
  budget: Budget,
): Promise<DraftEnemyAccount[]> {
  return Promise.all(
    enemies.map(async (p) => {
      const champion_id = (Number(p.championId) > 0 && catalog.byKey(Number(p.championId))?.id) || String(p.championId ?? '');
      const account: DraftEnemyAccount = { puuid: p.puuid ?? '', riot_id: p.riotId ?? null, champion_id, role: null };
      if (!p.puuid) return account;
      const [entries, masteriesRaw] = await Promise.all([
        budget.get<RawLeagueEntry[]>('league', { platform, puuid: p.puuid }).catch(() => null),
        budget.get<RawMastery[]>('masteries', { platform, puuid: p.puuid, count: ENEMY_MASTERY_COUNT }).catch(() => null),
      ]);
      if (entries) account.rank = pickRank(entries);
      if (masteriesRaw) {
        const masteries: MasteryEntry[] = mapMasteries(masteriesRaw, catalog, ENEMY_MASTERY_COUNT);
        account.masteries = masteries.slice(0, 5);
        account.champion_mastery = masteries.find((m) => m.champion_id === champion_id) ?? null;
      }
      return account;
    }),
  );
}

/**
 * Detected game applied to the draft: champions of both teams locked, roles and hand-assigned
 * friends kept where the champion matches, enemy accounts attached (roles from the enemy slots).
 */
export function mergeDetectedGame(base: DraftState, game: DetectedGame): DraftState {
  const takenAlly = new Set<number>();
  const ally: DraftAllySlot[] = game.ally.map((g) => {
    const i = base.ally.findIndex((b, j) => !takenAlly.has(j) && ((g.player_id && b.player_id === g.player_id) || (g.champion_id && b.champion_id === g.champion_id)));
    const b = i >= 0 ? base.ally[i] : undefined;
    if (i >= 0) takenAlly.add(i);
    return { ...g, player_id: g.player_id ?? b?.player_id ?? null, role: b?.role ?? null };
  });
  // Friends recognised nowhere else keep their slot if the game is missing players (should not happen).
  while (ally.length < DRAFT_SIZE) ally.push({ player_id: null, champion_id: null, role: null, locked: false });
  const seen = new Set<string>();
  for (const s of ally) {
    if (s.player_id && seen.has(s.player_id)) s.player_id = null;
    if (s.player_id) seen.add(s.player_id);
  }
  const enemy: DraftEnemySlot[] = game.enemy.map((g) => {
    const b = base.enemy.find((e) => e.champion_id && e.champion_id === g.champion_id);
    return { ...g, role: b?.role ?? null };
  });
  while (enemy.length < DRAFT_SIZE) enemy.push({ champion_id: null, role: null, locked: false });
  const roleOf = new Map(enemy.filter((e) => e.champion_id).map((e) => [e.champion_id as string, e.role ?? null]));
  return {
    ...base,
    source: 'spectator',
    phase: 'in_game',
    side: game.side ?? base.side ?? null,
    ally,
    enemy,
    ally_bans: game.ally_bans.length ? game.ally_bans : base.ally_bans,
    enemy_bans: game.enemy_bans.length ? game.enemy_bans : base.enemy_bans,
    enemy_accounts: game.enemy_accounts.map((a) => ({ ...a, role: roleOf.get(a.champion_id) ?? a.role ?? null })),
    game_id: game.game_id,
  };
}
