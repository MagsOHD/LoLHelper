// Mirrors web/backend/app/engine/models.py and the REST contract (snake_case JSON keys).

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
