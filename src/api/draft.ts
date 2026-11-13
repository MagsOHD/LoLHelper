// Live draft: shared draft documents (store "drafts"), companion payload mapping and merge rules.
// Pure functions first (unit-tested), then the thin I/O helpers.
import type { ChampionCatalog } from '../engine';
import type {
  ClashPosition,
  DraftAllySlot,
  DraftEnemySlot,
  DraftInput,
  DraftPhase,
  DraftSource,
  DraftState,
  EnemyPlayerProfile,
  EnemyProfileSource,
  MasteryEntry,
  PlaystyleStats,
  Player,
  PlayerInput,
  Rank,
  Role,
  TimelineStyle,
} from './types';
import { ROLES } from './types';
import { backendRequest, store } from './backend';
import { compactRecent, PROFILE_MASTERY_COUNT } from './enemyProfile';

export const DRAFT_SIZE = 5;
export const MAX_BANS = 5;

// ---- companion payload (sent by companion/lolhelper-draft.ps1, stored by PHP) ----------------

export type CompanionPhase = 'planning' | 'ban_pick' | 'finalization' | 'game_starting' | 'none';
export type CompanionPosition = 'top' | 'jungle' | 'middle' | 'bottom' | 'utility' | '';

export interface CompanionAllyCell {
  cell: number;
  puuid?: string;
  champion_key: number;
  intent_key?: number;
  position?: CompanionPosition | string;
}

export interface CompanionEnemyCell {
  cell: number;
  /** Only when the client itself shows the enemy (Clash, tournament, custom game); "" otherwise. */
  puuid?: string;
  champion_key: number;
}

export interface CompanionAction {
  type: 'ban' | 'pick' | string;
  champion_key: number;
  completed: boolean;
  ally: boolean;
  cell: number;
  in_progress: boolean;
}

export interface CompanionPayload {
  version: number;
  puuid: string;
  phase: CompanionPhase;
  queue_id?: number;
  local_cell?: number;
  my_team: CompanionAllyCell[];
  their_team: CompanionEnemyCell[];
  bans: { mine: number[]; theirs: number[] };
  actions: CompanionAction[];
  timer_remaining_ms?: number;
  sent_at?: string;
}

/** GET r=live-draft document: the payload plus what the server adds. */
export interface LiveDraft extends CompanionPayload {
  player_id: string;
  received_at: string;
}

/** A live document older than this (client clock) is ignored even if the server still returns it. */
export const LIVE_MAX_AGE_MS = 5 * 60 * 1000;

type KeyCatalog = { byKey: ChampionCatalog['byKey'] };
export interface FriendRef {
  id: string;
  puuid?: string | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0);
const unique = <T>(xs: T[]): T[] => Array.from(new Set(xs));
const isRole = (r: unknown): r is Role => typeof r === 'string' && (ROLES as string[]).includes(r);

/** Riot puuids are 78 base64url characters; anything else (or "") = identity unknown. */
const PUUID_RE = /^[A-Za-z0-9_-]{1,100}$/;
export function validPuuid(v: unknown): string | null {
  return typeof v === 'string' && PUUID_RE.test(v) ? v : null;
}

const POSITION_ROLE: Record<string, Role> = {
  top: 'TOP',
  jungle: 'JUNGLE',
  middle: 'MID',
  mid: 'MID',
  bottom: 'BOTTOM',
  utility: 'SUPPORT',
  support: 'SUPPORT',
};

export function positionToRole(position: unknown): Role | null {
  return typeof position === 'string' ? POSITION_ROLE[position.toLowerCase()] ?? null : null;
}

export function isLiveFresh(live: LiveDraft | null | undefined, now: number = Date.now()): live is LiveDraft {
  if (!live || live.phase === 'none') return false;
  const t = Date.parse(live.received_at);
  if (Number.isNaN(t)) return false;
  return now - t < LIVE_MAX_AGE_MS;
}

/** What the companion knows, mapped to Data Dragon ids and site players. */
export interface LiveMapping {
  phase: DraftPhase;
  side: 'blue' | 'red' | null;
  ally: DraftAllySlot[];
  enemy: DraftEnemySlot[];
  ally_bans: string[];
  enemy_bans: string[];
  /** Site player whose PC runs the companion. */
  owner_player_id: string;
}

function phaseOf(p: CompanionPayload): DraftPhase {
  switch (p.phase) {
    case 'planning':
      return 'planning';
    case 'ban_pick': {
      const actions = asArray<CompanionAction>(p.actions);
      const current = actions.find((a) => a && a.in_progress && !a.completed);
      if (current) return current.type === 'ban' ? 'ban' : 'pick';
      return actions.some((a) => a && a.type === 'ban' && !a.completed) ? 'ban' : 'pick';
    }
    case 'finalization':
    case 'game_starting':
      return 'finalization';
    default:
      return 'ended';
  }
}

/** CompanionPayload -> slots (numeric keys -> ids via catalog.byKey; friends matched by puuid). */
export function mapCompanionPayload(payload: CompanionPayload & { player_id?: string }, catalog: KeyCatalog, friends: FriendRef[]): LiveMapping {
  const champ = (key: unknown): string | null => {
    const k = int(key);
    return k > 0 ? catalog.byKey(k)?.id ?? null : null;
  };
  const actions = asArray<CompanionAction>(payload.actions).filter(isObject) as CompanionAction[];
  const hasPickActions = actions.some((a) => a.type === 'pick');
  const completedPick = (cell: number) => actions.some((a) => a.type === 'pick' && a.completed && int(a.cell) === cell && int(a.champion_key) > 0);
  const phase = phaseOf(payload);
  const draftOver = phase === 'finalization' || phase === 'ended';
  const byPuuid = new Map(friends.filter((f) => f.puuid).map((f) => [f.puuid as string, f.id]));

  const myTeam = asArray<CompanionAllyCell>(payload.my_team).filter(isObject)
    .sort((a, b) => int(a.cell) - int(b.cell)).slice(0, DRAFT_SIZE);
  const used = new Set<string>();
  const ally: DraftAllySlot[] = myTeam.map((m) => {
    const cell = int(m.cell);
    const picked = champ(m.champion_key);
    const intent = champ(m.intent_key);
    const puuid = (typeof m.puuid === 'string' && m.puuid) || (cell === int(payload.local_cell) ? payload.puuid : '');
    let player_id = puuid ? byPuuid.get(puuid) ?? null : null;
    if (player_id && used.has(player_id)) player_id = null;
    if (player_id) used.add(player_id);
    const locked = Boolean(picked) && (hasPickActions ? completedPick(cell) : draftOver);
    return { player_id, champion_id: picked ?? intent ?? null, role: positionToRole(m.position), locked };
  });

  const theirTeam = asArray<CompanionEnemyCell>(payload.their_team).filter(isObject)
    .sort((a, b) => int(a.cell) - int(b.cell)).slice(0, DRAFT_SIZE);
  const enemy: DraftEnemySlot[] = theirTeam.map((e) => {
    const id = champ(e.champion_key);
    const puuid = validPuuid(e.puuid);
    return {
      champion_id: id,
      role: null,
      locked: Boolean(id) && (hasPickActions ? completedPick(int(e.cell)) : true),
      ...(puuid ? { puuid } : {}),
    };
  });

  const bans = isObject(payload.bans) ? payload.bans : { mine: [], theirs: [] };
  const fromActions = (allySide: boolean) =>
    actions.filter((a) => a.type === 'ban' && a.completed && Boolean(a.ally) === allySide).map((a) => a.champion_key);
  const banIds = (keys: unknown[]) => unique(keys.map(champ).filter((c): c is string => !!c)).slice(0, MAX_BANS);

  const cells = myTeam.map((m) => int(m.cell));
  return {
    phase,
    side: cells.length ? (cells.some((c) => c >= 5) ? 'red' : 'blue') : null,
    ally,
    enemy,
    ally_bans: banIds([...asArray<number>(bans.mine), ...fromActions(true)]),
    enemy_bans: banIds([...asArray<number>(bans.theirs), ...fromActions(false)]),
    owner_player_id: payload.player_id ?? byPuuid.get(payload.puuid) ?? '',
  };
}

/** Which parts of the draft the companion fills (shown in the UI). */
export interface Coverage {
  ally: boolean[];
  enemy: boolean[];
  bans: boolean;
}

export function coverageOf(m: LiveMapping | null): Coverage | null {
  if (!m) return null;
  return {
    ally: Array.from({ length: DRAFT_SIZE }, (_, i) => i < m.ally.length),
    enemy: Array.from({ length: DRAFT_SIZE }, (_, i) => i < m.enemy.length),
    bans: true,
  };
}

// ---- draft documents -----------------------------------------------------------------------

export type DraftKind = 'team' | 'player';

export function draftDocId(kind: DraftKind, id: string): string {
  return `${kind}-${id}`;
}

export function nowIso(now: number = Date.now()): string {
  return new Date(now).toISOString();
}

const emptyAlly = (): DraftAllySlot => ({ player_id: null, champion_id: null, role: null, locked: false });
const emptyEnemy = (): DraftEnemySlot => ({ champion_id: null, role: null, locked: false });

/** Fresh draft: friends in the first slots, unknown teammates ("Coéquipier") after. */
export function emptyDraft(id: string, playerIds: string[], teamId: string | null = null, now?: number): DraftState {
  const ids = unique(playerIds).slice(0, DRAFT_SIZE);
  return {
    id,
    team_id: teamId,
    player_ids: ids,
    source: 'manual',
    phase: 'planning',
    side: null,
    ally_bans: [],
    enemy_bans: [],
    ally: Array.from({ length: DRAFT_SIZE }, (_, i) => ({ ...emptyAlly(), player_id: ids[i] ?? null })),
    enemy: Array.from({ length: DRAFT_SIZE }, emptyEnemy),
    enemy_accounts: [],
    enemy_profiles: [],
    game_id: null,
    updated_at: nowIso(now),
  };
}

const PHASES: DraftPhase[] = ['planning', 'ban', 'pick', 'finalization', 'in_game', 'ended'];
const SOURCES: DraftSource[] = ['manual', 'companion', 'spectator'];
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Store document -> well-formed DraftState (5 + 5 slots, valid roles, string ids). */
export function normalizeDraft(raw: unknown, fallback: DraftState): DraftState {
  if (!isObject(raw)) return fallback;
  const ally: DraftAllySlot[] = asArray<Record<string, unknown>>(raw.ally).slice(0, DRAFT_SIZE).map((s) => ({
    player_id: isObject(s) ? str(s.player_id) : null,
    champion_id: isObject(s) ? str(s.champion_id) : null,
    role: isObject(s) && isRole(s.role) ? s.role : null,
    locked: isObject(s) && s.locked === true,
  }));
  while (ally.length < DRAFT_SIZE) ally.push(emptyAlly());
  const enemy: DraftEnemySlot[] = asArray<Record<string, unknown>>(raw.enemy).slice(0, DRAFT_SIZE).map((s) => {
    const puuid = isObject(s) ? validPuuid(s.puuid) : null;
    return {
      champion_id: isObject(s) ? str(s.champion_id) : null,
      role: isObject(s) && isRole(s.role) ? s.role : null,
      locked: isObject(s) && s.locked === true,
      ...(puuid ? { puuid } : {}),
    };
  });
  while (enemy.length < DRAFT_SIZE) enemy.push(emptyEnemy());
  const bans = (v: unknown) => unique(asArray<unknown>(v).map(str).filter((c): c is string => !!c)).slice(0, MAX_BANS);
  return {
    id: fallback.id,
    team_id: str(raw.team_id) ?? fallback.team_id ?? null,
    player_ids: fallback.player_ids,
    source: SOURCES.includes(raw.source as DraftSource) ? (raw.source as DraftSource) : 'manual',
    phase: PHASES.includes(raw.phase as DraftPhase) ? (raw.phase as DraftPhase) : 'planning',
    side: raw.side === 'blue' || raw.side === 'red' ? raw.side : null,
    ally_bans: bans(raw.ally_bans),
    enemy_bans: bans(raw.enemy_bans),
    ally,
    enemy,
    enemy_accounts: asArray(raw.enemy_accounts),
    enemy_profiles: normalizeProfiles(raw.enemy_profiles),
    game_id: typeof raw.game_id === 'number' ? raw.game_id : null,
    updated_at: str(raw.updated_at) ?? fallback.updated_at,
  };
}

/** Comparable content (everything but the timestamp). */
export function draftContentKey(d: DraftState): string {
  const { updated_at: _u, ...rest } = d;
  void _u;
  return JSON.stringify(rest);
}

/** Phase deduced from a manually entered draft (the companion/spectator give it directly). */
export function inferPhase(d: DraftState): DraftPhase {
  if (d.phase === 'in_game') return 'in_game';
  const allyChamps = d.ally.filter((s) => s.champion_id);
  const enemyChamps = d.enemy.filter((s) => s.champion_id);
  if (allyChamps.length === DRAFT_SIZE && enemyChamps.length === DRAFT_SIZE && d.ally.every((s) => s.locked)) return 'finalization';
  if (allyChamps.length || enemyChamps.length) return 'pick';
  if (d.ally_bans.length || d.enemy_bans.length) return 'ban';
  return 'planning';
}

/** Every champion already used (picks of both teams + bans): excluded from pickers. */
export function usedChampions(d: DraftState): string[] {
  return unique([
    ...d.ally.map((s) => s.champion_id),
    ...d.enemy.map((s) => s.champion_id),
    ...d.ally_bans,
    ...d.enemy_bans,
  ].filter((c): c is string => !!c));
}

export function toDraftInput(d: DraftState): DraftInput {
  const profiles = activeEnemyProfiles(d);
  return {
    ally: d.ally,
    enemy: d.enemy,
    bans: unique([...d.ally_bans, ...d.enemy_bans]),
    // Enemy accounts are only known (and only used) once the game has started.
    ...(d.phase === 'in_game' && d.enemy_accounts?.length ? { enemy_accounts: d.enemy_accounts } : {}),
    ...(profiles.length ? { enemy_profiles: profiles } : {}),
    side: d.side ?? null,
    phase: d.phase,
  };
}

/** Engine input for a site player (same fields as the composition generator's builder). */
export function playerToInput(p: Player): PlayerInput {
  const role_games: Partial<Record<Role, number>> = {};
  for (const [k, v] of Object.entries(p.recent?.roles ?? {})) if (isRole(k)) role_games[k] = Math.trunc(Number(v) || 0);
  return {
    player_id: p.id,
    name: p.game_name,
    preferences: p.preferences,
    role_games,
    pool: p.pool,
    puuid: p.puuid ?? null,
    lane_history: p.recent?.lane_matchups ?? [],
    allies: p.recent?.allies ?? [],
  };
}

// ---- field paths (protect what the local user is editing) ------------------------------------

/** "ally.<i>", "enemy.<i>", "ally_bans", "enemy_bans", "enemy_profiles". */
export type DraftPath = string;

export function copyPath(from: DraftState, to: DraftState, path: DraftPath): DraftState {
  const [field, idx] = path.split('.');
  if ((field === 'ally' || field === 'enemy') && idx !== undefined) {
    const i = Number(idx);
    if (!Number.isInteger(i) || i < 0 || i >= DRAFT_SIZE) return to;
    if (field === 'ally') {
      const ally = [...to.ally];
      ally[i] = { ...from.ally[i] };
      return { ...to, ally };
    }
    const enemy = [...to.enemy];
    enemy[i] = { ...from.enemy[i] };
    return { ...to, enemy };
  }
  if (field === 'ally_bans' || field === 'enemy_bans') return { ...to, [field]: [...from[field]] };
  if (field === 'enemy_profiles') return { ...to, enemy_profiles: [...(from.enemy_profiles ?? [])] };
  return to;
}

/** Remote document adopted, except the protected paths which keep the local value. */
export function adoptRemote(local: DraftState, remote: DraftState, protectedPaths: Iterable<DraftPath>): DraftState {
  let out = remote;
  for (const p of protectedPaths) out = copyPath(local, out, p);
  return out;
}

/**
 * Companion data overrides the slots it covers (champion, lock state, phase, bans). Kept from the
 * base draft: ally roles the client does not know, friends assigned by hand to a slot whose puuid
 * the client did not give, enemy roles, and any path the local user is editing (`held`).
 */
export function mergeCompanion(base: DraftState, live: LiveMapping, held: Iterable<DraftPath> = []): DraftState {
  const heldSet = new Set(held);
  const matched = new Set(live.ally.map((s) => s.player_id).filter((x): x is string => !!x));
  const ally = base.ally.map((b, i) => {
    const c = live.ally[i];
    if (!c || heldSet.has(`ally.${i}`)) return b;
    const keepPlayer = b.player_id && !matched.has(b.player_id) ? b.player_id : null;
    return {
      player_id: c.player_id ?? keepPlayer,
      champion_id: c.champion_id ?? null,
      role: c.role ?? b.role ?? null,
      locked: c.locked,
    };
  });
  // A friend matched by puuid elsewhere cannot stay on an uncovered slot.
  for (let i = live.ally.length; i < ally.length; i++) {
    const pid = ally[i].player_id;
    if (pid && matched.has(pid) && !heldSet.has(`ally.${i}`)) ally[i] = { ...ally[i], player_id: null };
  }
  const enemy = base.enemy.map((b, i) => {
    const c = live.enemy[i];
    if (!c || heldSet.has(`enemy.${i}`)) return b;
    const role = c.champion_id && c.champion_id === b.champion_id ? b.role ?? null : null;
    return { champion_id: c.champion_id ?? null, role, locked: c.locked, ...(c.puuid ? { puuid: c.puuid } : {}) };
  });
  return {
    ...base,
    source: 'companion',
    phase: live.phase === 'ended' ? base.phase : live.phase,
    side: live.side ?? base.side ?? null,
    ally,
    enemy,
    ally_bans: heldSet.has('ally_bans') ? base.ally_bans : live.ally_bans,
    enemy_bans: heldSet.has('enemy_bans') ? base.enemy_bans : live.enemy_bans,
    // Still in champion select: any previous game is over.
    enemy_accounts: [],
    game_id: null,
  };
}

// ---- enemy profiles in the shared document -------------------------------------------------

/** Scouting entries per draft (one enemy team). */
export const MAX_SCOUTED = DRAFT_SIZE;
/** Profiles kept in the document: 5 scouted + 5 from the client / the started game. */
export const MAX_ENEMY_PROFILES = 2 * DRAFT_SIZE;
const PROFILE_SOURCES: EnemyProfileSource[] = ['scouting', 'clash', 'client', 'game'];
const SOURCE_RANK: Record<EnemyProfileSource, number> = { scouting: 0, clash: 1, client: 2, game: 3 };
const MAX_RIOT_ID = 64;

const finite = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const r2 = (x: number) => Math.round(x * 100) / 100;

function normalizeRank(v: unknown): Rank | null {
  if (!isObject(v) || typeof v.tier !== 'string' || !v.tier) return null;
  return {
    queue: str(v.queue) ?? 'RANKED_SOLO_5x5',
    tier: v.tier,
    division: typeof v.division === 'string' ? v.division : '',
    lp: Math.trunc(finite(v.lp)),
    wins: Math.trunc(finite(v.wins)),
    losses: Math.trunc(finite(v.losses)),
  };
}

const optFinite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? r2(v) : null);
const LANES: Role[] = ['TOP', 'MID', 'BOTTOM'];

function normalizeTimeline(v: unknown): TimelineStyle | null {
  if (!isObject(v) || !(finite(v.games) > 0)) return null;
  return {
    games: Math.trunc(finite(v.games)),
    gold_diff_10: optFinite(v.gold_diff_10),
    cs_10: optFinite(v.cs_10),
    kills_before_10: r2(finite(v.kills_before_10)),
    deaths_before_10: r2(finite(v.deaths_before_10)),
    first_gank_minute: optFinite(v.first_gank_minute),
    first_gank_lane: LANES.includes(v.first_gank_lane as Role) ? (v.first_gank_lane as Role) : null,
    first_back_minute: optFinite(v.first_back_minute),
    wards_per_min: r2(finite(v.wards_per_min)),
    level6_minute: optFinite(v.level6_minute),
  };
}

const CLASH_POSITIONS: ClashPosition[] = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY', 'FILL', 'UNSELECTED'];
const TEAM_ID = /^[A-Za-z0-9-]{1,64}$/;

/** undefined = never looked up, null = looked up (no Clash team), else the team reference. */
function normalizeClashTeam(v: unknown): EnemyPlayerProfile['clash_team'] | undefined {
  if (v === null) return null;
  if (!isObject(v) || typeof v.id !== 'string' || !TEAM_ID.test(v.id)) return undefined;
  return { id: v.id, name: (str(v.name) ?? 'Équipe Clash').slice(0, 64), abbreviation: (str(v.abbreviation) ?? '').slice(0, 8) };
}

function normalizeStyle(v: unknown): PlaystyleStats | null {
  if (!isObject(v) || !(finite(v.games) > 0)) return null;
  const f = (k: string) => r2(finite(v[k]));
  const timeline = normalizeTimeline(v.timeline);
  return {
    games: Math.trunc(finite(v.games)),
    wins: Math.trunc(finite(v.wins)),
    kills: f('kills'),
    deaths: f('deaths'),
    assists: f('assists'),
    cs_per_min: f('cs_per_min'),
    vision_per_min: f('vision_per_min'),
    damage_per_min: f('damage_per_min'),
    kill_participation: f('kill_participation'),
    solo_kills: f('solo_kills'),
    first_blood_rate: f('first_blood_rate'),
    early_lead: typeof v.early_lead === 'number' && Number.isFinite(v.early_lead) ? r2(v.early_lead) : null,
    turret_takedowns: f('turret_takedowns'),
    avg_game_minutes: f('avg_game_minutes'),
    ...(timeline ? { timeline } : {}),
  };
}

/** Store value -> compact, well-formed profile (null when unusable). Caps: 20 masteries, 15 champions, no history lists. */
export function normalizeProfile(raw: unknown): EnemyPlayerProfile | null {
  if (!isObject(raw)) return null;
  const puuid = validPuuid(raw.puuid);
  if (!puuid) return null;
  const masteries: MasteryEntry[] = asArray<unknown>(raw.masteries)
    .filter(isObject)
    .filter((m) => typeof m.champion_id === 'string' && m.champion_id)
    .slice(0, PROFILE_MASTERY_COUNT)
    .map((m) => ({
      champion_id: m.champion_id as string,
      level: Math.trunc(finite(m.level)),
      points: Math.trunc(finite(m.points)),
      ...(typeof m.last_play_time === 'number' ? { last_play_time: m.last_play_time } : {}),
    }));
  const recentRaw = isObject(raw.recent) ? raw.recent : {};
  const recent = compactRecent({
    games: finite(recentRaw.games),
    roles: isObject(recentRaw.roles) ? Object.fromEntries(Object.entries(recentRaw.roles).filter(([k]) => isRole(k))) : {},
    champions: asArray<unknown>(recentRaw.champions)
      .filter(isObject)
      .filter((c) => typeof c.champion_id === 'string' && c.champion_id)
      .map((c) => ({
        champion_id: c.champion_id as string,
        games: finite(c.games),
        wins: finite(c.wins),
        kills: finite(c.kills),
        deaths: finite(c.deaths),
        assists: finite(c.assists),
        role: isRole(c.role) ? c.role : null,
        last_played: typeof c.last_played === 'number' ? c.last_played : null,
      })),
  });
  const riot = str(raw.riot_id);
  const clashTeam = normalizeClashTeam(raw.clash_team);
  return {
    puuid,
    riot_id: riot ? riot.slice(0, MAX_RIOT_ID) : null,
    source: PROFILE_SOURCES.includes(raw.source as EnemyProfileSource) ? (raw.source as EnemyProfileSource) : 'scouting',
    summoner_level: typeof raw.summoner_level === 'number' && Number.isFinite(raw.summoner_level) ? Math.trunc(raw.summoner_level) : null,
    rank: normalizeRank(raw.rank),
    masteries,
    recent,
    style: normalizeStyle(raw.style),
    champion_id: str(raw.champion_id),
    role: isRole(raw.role) ? raw.role : null,
    ...(clashTeam !== undefined
      ? { clash_team: clashTeam, clash_position: clashTeam && CLASH_POSITIONS.includes(raw.clash_position as ClashPosition) ? (raw.clash_position as ClashPosition) : null }
      : {}),
    fetched_at: str(raw.fetched_at) ?? '',
  };
}

/** Keeps the document small: at most MAX_ENEMY_PROFILES, scouting first, then the most recent. */
export function capProfiles(list: EnemyPlayerProfile[]): EnemyPlayerProfile[] {
  if (list.length <= MAX_ENEMY_PROFILES) return list;
  const keep = new Set(
    [...list]
      .sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || (a.fetched_at < b.fetched_at ? 1 : a.fetched_at > b.fetched_at ? -1 : 0))
      .slice(0, MAX_ENEMY_PROFILES),
  );
  return list.filter((p) => keep.has(p));
}

export function normalizeProfiles(raw: unknown): EnemyPlayerProfile[] {
  const seen = new Set<string>();
  const out: EnemyPlayerProfile[] = [];
  for (const r of asArray<unknown>(raw)) {
    const p = normalizeProfile(r);
    if (!p || seen.has(p.puuid)) continue;
    seen.add(p.puuid);
    out.push(p);
  }
  return capProfiles(out);
}

/**
 * Adds or refreshes a profile (same puuid = same player). The strongest source is kept (a scouted
 * player stays in the scouting list once the client or the game reveals him), as is a known Riot ID.
 */
export function upsertProfile(list: EnemyPlayerProfile[] | undefined, incoming: EnemyPlayerProfile): EnemyPlayerProfile[] {
  const p = normalizeProfile(incoming);
  if (!p) return list ?? [];
  const cur = list ?? [];
  const i = cur.findIndex((x) => x.puuid === p.puuid);
  if (i < 0) return capProfiles([...cur, p]);
  const old = cur[i];
  const merged: EnemyPlayerProfile = {
    ...p,
    source: SOURCE_RANK[old.source] <= SOURCE_RANK[p.source] ? old.source : p.source,
    riot_id: old.riot_id ?? p.riot_id ?? null,
  };
  // A rebuilt profile without Clash data keeps what was looked up before.
  if (p.clash_team === undefined && old.clash_team !== undefined) {
    merged.clash_team = old.clash_team;
    merged.clash_position = old.clash_position ?? null;
  }
  // Same for the timeline facts (a quicker rebuild may have skipped them).
  if (merged.style && !merged.style.timeline && old.style?.timeline) merged.style = { ...merged.style, timeline: old.style.timeline };
  return cur.map((x, j) => (j === i ? merged : x));
}

export function removeProfile(list: EnemyPlayerProfile[] | undefined, puuid: string): EnemyPlayerProfile[] {
  return (list ?? []).filter((p) => p.puuid !== puuid);
}

export function scoutedProfiles(d: DraftState): EnemyPlayerProfile[] {
  return (d.enemy_profiles ?? []).filter((p) => p.source === 'scouting');
}

/** Members of an enemy Clash team added from a roster (source "clash"). */
export function clashProfiles(d: DraftState): EnemyPlayerProfile[] {
  return (d.enemy_profiles ?? []).filter((p) => p.source === 'clash');
}

/** Profiles kept when the draft is reset: scouted players and their Clash teammates. */
export function keptOnReset(d: DraftState): EnemyPlayerProfile[] {
  return (d.enemy_profiles ?? []).filter((p) => p.source === 'scouting' || p.source === 'clash');
}

/** Sets Clash data on known profiles (puuid -> team/position); unchanged list when nothing changes. */
export function annotateClash(
  list: EnemyPlayerProfile[] | undefined,
  updates: { puuid: string; team: EnemyPlayerProfile['clash_team']; position: ClashPosition | null }[],
): EnemyPlayerProfile[] {
  const cur = list ?? [];
  let changed = false;
  const by = new Map(updates.map((u) => [u.puuid, u]));
  const out = cur.map((p) => {
    const u = by.get(p.puuid);
    if (!u) return p;
    const position = u.team ? u.position : null;
    if (JSON.stringify(p.clash_team ?? null) === JSON.stringify(u.team ?? null) && (p.clash_position ?? null) === position && p.clash_team !== undefined) return p;
    changed = true;
    return { ...p, clash_team: u.team ?? null, clash_position: position };
  });
  return changed ? out : cur;
}

/**
 * Profiles relevant now, with their current champion/role: scouted players always; client-revealed
 * players while their puuid is in an enemy slot; started-game players while that game is shown.
 * Nothing is ever inferred from an anonymous slot.
 */
export function activeEnemyProfiles(d: DraftState): EnemyPlayerProfile[] {
  const slots = new Map<string, DraftEnemySlot>();
  for (const s of d.enemy) if (s.puuid) slots.set(s.puuid, s);
  const inGame = d.phase === 'in_game';
  const accounts = new Map((inGame ? d.enemy_accounts ?? [] : []).filter((a) => a.puuid).map((a) => [a.puuid, a]));
  const out: EnemyPlayerProfile[] = [];
  for (const p of d.enemy_profiles ?? []) {
    const slot = slots.get(p.puuid);
    const acc = accounts.get(p.puuid);
    if (p.source === 'client' && !slot && !acc) continue;
    if (p.source === 'game' && !acc) continue;
    // Scouted ahead of time (Riot ID or Clash roster): champion and role only from the draft/game.
    const ahead = p.source === 'scouting' || p.source === 'clash';
    out.push({
      ...p,
      riot_id: p.riot_id ?? acc?.riot_id ?? null,
      champion_id: acc?.champion_id || slot?.champion_id || (ahead ? null : p.champion_id ?? null),
      role: acc?.role ?? slot?.role ?? (ahead ? null : p.role ?? null),
    });
  }
  return out;
}

// ---- I/O -----------------------------------------------------------------------------------

const STORE_ID = /^[A-Za-z0-9-]{1,64}$/;

export async function loadDraft(id: string): Promise<DraftState | null> {
  if (!STORE_ID.test(id)) return null;
  return store.get<DraftState>('drafts', id);
}

export function saveDraft(doc: DraftState): Promise<DraftState> {
  return store.put<DraftState>('drafts', doc);
}

/** Most recent fresh companion document among these players (≤ 5 ids), null when none. */
export async function fetchLiveDraft(playerIds: string[]): Promise<LiveDraft | null> {
  const ids = unique(playerIds.filter((id) => STORE_ID.test(id))).slice(0, DRAFT_SIZE);
  if (!ids.length) return null;
  const res = await backendRequest<{ live?: LiveDraft | null }>('GET', 'live-draft', { params: { players: ids.join(',') } });
  const live = res && isObject(res) ? res.live : null;
  return live && isObject(live) ? live : null;
}
