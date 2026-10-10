// Shared data types (snake_case keys, as stored by the PHP API and produced by the engine).

export type Role = 'TOP' | 'JUNGLE' | 'MID' | 'BOTTOM' | 'SUPPORT';
export const ROLES: Role[] = ['TOP', 'JUNGLE', 'MID', 'BOTTOM', 'SUPPORT'];

export type DamageType = 'AD' | 'AP' | 'MIXED';
export type ThemeKind = 'playstyle' | 'thematic';

export interface ChampionTraits {
  engage: number;
  peel: number;
  poke: number;
  waveclear: number;
  splitpush: number;
  pick: number;
  teamfight: number;
  early: number;
  late: number;
  mobility: number;
  frontline: number;
  cc: number;
  sustain: number;
  objective: number;
}

export interface ChampionInfo {
  id: string;
  key: number;
  name: string;
  title: string;
  image_url: string;
  tags: string[];
  roles: Role[];
  archetype: string;
  damage_type: DamageType;
  region: string;
  groups: string[];
  traits: ChampionTraits;
}

export interface ArchetypeInfo {
  key: string;
  label: string;
  description: string;
}

export interface ThemeInfo {
  key: string;
  label: string;
  kind: ThemeKind;
  description: string;
}

export interface MasteryEntry {
  champion_id: string;
  level: number;
  points: number;
  last_play_time?: number | null;
}

export interface RecentChampionStat {
  champion_id: string;
  games: number;
  wins: number;
  kills: number;
  deaths: number;
  assists: number;
  role?: Role | null;
  /** Epoch ms of the most recent game on this champion (recent form / recency). */
  last_played?: number | null;
}

/** One lane duel actually played by a player in their recent games (same position, opposite team). */
export interface LaneHistoryEntry {
  champion_id: string; // champion the player used
  opponent_id: string; // enemy laner's champion
  role: Role;
  games: number;
  wins: number;
}

export interface AllyChampionPair {
  champion_id: string; // champion the player used
  ally_champion_id: string; // champion the ally used in the same game
  games: number;
  wins: number;
}

/** Recent games played on the same team as another account (identified by puuid). */
export interface AllyHistory {
  puuid: string;
  games: number;
  wins: number;
  pairs: AllyChampionPair[];
}

export interface PlayerPreferences {
  roles: Role[];
  wanted_archetypes: string[];
  wanted_champions: string[];
  avoided_champions: string[];
}

export interface ManualPoolEntry {
  champion_id: string;
  comfort: number;
}

export type PoolSource = 'mastery' | 'recent' | 'manual' | 'wanted';

export interface PoolEntry {
  champion_id: string;
  comfort: number;
  desire: number;
  sources: PoolSource[];
  mastery_points?: number;
  mastery_level?: number;
  recent_games?: number;
  recent_wins?: number;
  /** Recent form on this champion, -1 (losing streak) .. 1 (winning streak), 0 = neutral/unknown. */
  form?: number;
}

export interface PlayerInput {
  player_id: string;
  name: string;
  preferences: PlayerPreferences;
  role_games: Partial<Record<Role, number>>;
  pool: PoolEntry[];
  /** Riot account, used to match `allies` between team members. */
  puuid?: string | null;
  lane_history?: LaneHistoryEntry[];
  allies?: AllyHistory[];
}

/** [games, wins] */
export type GamesWins = [number, number];

/** Aggregated high-elo stats for one patch, champion keys already mapped to Data Dragon ids. */
export interface MetaStats {
  patch: string;
  platform: string;
  games: number; // matches aggregated
  updated_at: string;
  /** champion_id -> role -> [games, wins] */
  champions: Record<string, Partial<Record<Role, GamesWins>>>;
  /** champion_id -> number of matches where it was banned */
  bans: Record<string, number>;
  /** role -> champion_id -> opponent champion_id (same role, enemy team) -> [games, wins of champion_id] */
  matchups: Partial<Record<Role, Record<string, Record<string, GamesWins>>>>;
}

/** Optional data shared by the engine entry points; every field is optional and ignored when absent. */
export interface EngineContext {
  meta?: MetaStats | null;
  /** Players of the ally team (history used by the matchup plan). */
  players?: PlayerInput[];
}

export interface GenerationOptions {
  theme?: string | null;
  role_assignments?: Record<string, Role>;
  locked_picks?: Record<string, string>;
  bans?: string[];
  enemy_champions?: string[];
  count?: number;
  exploration?: number;
}

export interface ScoreBreakdown {
  comfort: number;
  desire: number;
  theme_fit: number;
  balance: number;
  counter?: number | null;
  /** Only when meta stats are available (0..100). */
  meta?: number | null;
}

export interface Pick {
  role: Role;
  champion_id: string;
  player_id?: string | null;
}

export interface SuggestedPick extends Pick {
  comfort: number;
  desire: number;
  reasons: string[];
}

export interface CompositionSuggestion {
  theme: string;
  theme_label: string;
  score: number;
  breakdown: ScoreBreakdown;
  picks: SuggestedPick[];
  strengths: string[];
  warnings: string[];
}

export interface PhasePlan {
  phase: 'early' | 'mid' | 'late';
  summary: string;
  tips: string[];
}

export interface RoleTip {
  role: Role;
  champion_id: string;
  tips: string[];
}

export interface GamePlan {
  identity: string;
  detected_themes: string[];
  win_conditions: string[];
  phases: PhasePlan[];
  power_spikes: string[];
  key_combos: string[];
  objectives: string[];
  role_tips: RoleTip[];
  avoid: string[];
  damage_profile: Record<string, number>;
}

export interface ThreatInfo {
  champion_id: string;
  danger: number; // 1..3
  why: string;
  how_to_handle: string;
}

export interface LaneMatchup {
  role: Role;
  ally_champion_id: string;
  enemy_champion_id: string;
  advice: string;
}

export interface MatchupPlan {
  enemy_identity: string;
  enemy_themes: string[];
  enemy_win_conditions: string[];
  how_to_win: string[];
  threats: ThreatInfo[];
  lane_matchups: LaneMatchup[];
  objectives: string[];
  suggested_bans: string[];
}

// ---- API-level shapes ----

export interface Meta {
  ddragon_version: string;
  riot_configured: boolean;
  platform: string;
  region: string;
  platforms: string[];
  password_required?: boolean;
  /** PHP store writable (OVH hosting). */
  storage_ok?: boolean;
  /** Summary of the collected high-elo meta, null when nothing has been collected yet. */
  meta_stats?: { patch: string; games: number; updated_at: string } | null;
}

export interface Rank {
  queue: string;
  tier: string;
  division: string;
  lp: number;
  wins: number;
  losses: number;
}

export interface RecentSummary {
  games: number;
  roles: Partial<Record<Role, number>>;
  champions: RecentChampionStat[];
  lane_matchups?: LaneHistoryEntry[];
  allies?: AllyHistory[];
}

export interface Player {
  id: string;
  game_name: string;
  tag_line: string;
  platform: string;
  puuid: string | null;
  profile_icon_url: string;
  summoner_level: number | null;
  rank: Rank | null;
  last_synced_at: string | null;
  preferences: PlayerPreferences;
  masteries: MasteryEntry[];
  recent: RecentSummary;
  manual_pool: ManualPoolEntry[];
  pool: PoolEntry[];
}

export interface CreatePlayerBody {
  game_name: string;
  tag_line: string;
  platform?: string;
}

export interface Team {
  id: string;
  name: string;
  player_ids: string[];
  created_at: string;
}

export interface TeamBody {
  name: string;
  player_ids: string[];
}

export interface GenerateBody {
  player_ids: string[];
  options: GenerationOptions;
}

export interface EnemyPick {
  champion_id: string;
  role?: Role | null;
}

export interface MatchupBody {
  ally: Pick[];
  enemy: EnemyPick[];
}

export interface SaveCompositionBody {
  name: string;
  team_id?: string | null;
  theme?: string | null;
  picks: Pick[];
  notes?: string | null;
}

export interface SavedComposition extends SaveCompositionBody {
  id: string;
  created_at: string;
}
