// Local implementation of the page-facing API: business rules (ported from
// the former Python backend) on top of the PHP document store, the Riot proxy
// and the in-browser composition engine.
import {
  buildGamePlan,
  buildMatchupPlan,
  computePool,
  generateCompositions,
  listArchetypes,
  listThemes,
  type ChampionCatalog,
} from '../engine';
import type {
  ArchetypeInfo,
  ChampionInfo,
  CompositionSuggestion,
  CreatePlayerBody,
  EnemyPick,
  GamePlan,
  GenerateBody,
  GenerationOptions,
  ManualPoolEntry,
  MasteryEntry,
  MatchupBody,
  MatchupPlan,
  Meta,
  Pick,
  Player,
  PlayerInput,
  PlayerPreferences,
  Rank,
  RecentSummary,
  Role,
  SaveCompositionBody,
  SavedComposition,
  Team,
  TeamBody,
  ThemeInfo,
} from './types';
import { ROLES } from './types';
import { ApiError, backendRequest, store } from './backend';
import { getCatalog, profileIconUrl } from './ddragon';
import { emptyRecent, emptyRoles, fetchPlayerData, getAccount, type RiotFields } from './riot';

// ---- helpers ---------------------------------------------------------------------------------

const unprocessable = (msg: string) => new ApiError(msg, 422);
const notFound = (msg: string) => new ApiError(msg, 404);

export function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function newId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const STORE_ID = /^[A-Za-z0-9-]{1,64}$/;

const unique = <T>(xs: T[]): T[] => Array.from(new Set(xs));
const isRole = (r: unknown): r is Role => typeof r === 'string' && (ROLES as string[]).includes(r);
const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

function validateChampions(catalog: ChampionCatalog, ids: string[]): void {
  const unknown = unique(ids).filter((c) => !catalog.get(c));
  if (unknown.length) {
    const label = unknown.length === 1 ? 'Champion inconnu' : 'Champions inconnus';
    throw unprocessable(`${label} : ${unknown.join(', ')}.`);
  }
}

function validateRoles(roles: unknown[]): void {
  const bad = roles.filter((r) => !isRole(r));
  if (bad.length) throw unprocessable(`Rôle inconnu : ${bad.map(String).join(', ')}.`);
}

// ---- meta ------------------------------------------------------------------------------------

type PhpMeta = Omit<Meta, 'ddragon_version'>;

let phpMetaPromise: Promise<PhpMeta> | null = null;

function phpMeta(): Promise<PhpMeta> {
  if (!phpMetaPromise) {
    phpMetaPromise = backendRequest<PhpMeta>('GET', 'meta').catch((err) => {
      phpMetaPromise = null;
      throw err;
    });
  }
  return phpMetaPromise;
}

/** Tests only. */
export function resetServiceForTests(): void {
  phpMetaPromise = null;
}

// ---- stored documents ------------------------------------------------------------------------

/** What the PHP store holds for a player (no computed `pool`, no icon URL). */
export interface PlayerDoc {
  id: string;
  game_name: string;
  tag_line: string;
  platform: string;
  puuid: string | null;
  profile_icon_id: number | null;
  summoner_level: number | null;
  rank: Rank | null;
  masteries: MasteryEntry[];
  recent: RecentSummary | null;
  preferences: PlayerPreferences;
  manual_pool: ManualPoolEntry[];
  last_synced_at: string | null;
  created_at: string;
}

function emptyPreferences(): PlayerPreferences {
  return { roles: [], wanted_archetypes: [], wanted_champions: [], avoided_champions: [] };
}

function docPreferences(doc: Partial<PlayerDoc>): PlayerPreferences {
  const p = (doc.preferences ?? {}) as Partial<PlayerPreferences>;
  return {
    roles: asArray<Role>(p.roles),
    wanted_archetypes: asArray<string>(p.wanted_archetypes),
    wanted_champions: asArray<string>(p.wanted_champions),
    avoided_champions: asArray<string>(p.avoided_champions),
  };
}

function docRecent(doc: Partial<PlayerDoc>): RecentSummary {
  const r = doc.recent;
  if (!r) return emptyRecent();
  return { games: r.games ?? 0, roles: r.roles ?? emptyRoles(), champions: asArray(r.champions) };
}

function playerPool(doc: Partial<PlayerDoc>, catalog: ChampionCatalog) {
  return computePool(
    asArray<MasteryEntry>(doc.masteries),
    docRecent(doc).champions,
    asArray<ManualPoolEntry>(doc.manual_pool),
    docPreferences(doc),
    catalog,
  );
}

export function toPlayer(doc: PlayerDoc, catalog: ChampionCatalog, version: string): Player {
  return {
    id: doc.id,
    game_name: doc.game_name,
    tag_line: doc.tag_line,
    platform: doc.platform,
    puuid: doc.puuid ?? null,
    profile_icon_url: profileIconUrl(version, doc.profile_icon_id),
    summoner_level: doc.summoner_level ?? null,
    rank: doc.rank ?? null,
    last_synced_at: doc.last_synced_at ?? null,
    preferences: docPreferences(doc),
    masteries: asArray(doc.masteries),
    recent: docRecent(doc),
    manual_pool: asArray(doc.manual_pool),
    pool: playerPool(doc, catalog),
  };
}

export function toPlayerInput(doc: PlayerDoc, catalog: ChampionCatalog): PlayerInput {
  const roles = docRecent(doc).roles;
  const role_games: Partial<Record<Role, number>> = {};
  for (const [k, v] of Object.entries(roles)) if (isRole(k)) role_games[k] = Math.trunc(Number(v) || 0);
  return {
    player_id: doc.id,
    name: doc.game_name,
    preferences: docPreferences(doc),
    role_games,
    pool: playerPool(doc, catalog),
  };
}

const listPlayerDocs = () => store.list<PlayerDoc>('players');
const listTeamDocs = () => store.list<Team>('teams');
const listSavedDocs = () => store.list<SavedComposition>('saved');

async function getPlayerDoc(id: string): Promise<PlayerDoc> {
  const doc = (await listPlayerDocs()).find((p) => p.id === id);
  if (!doc) throw notFound('Joueur introuvable.');
  return doc;
}

const fold = (s: string) => s.trim().toLowerCase();

function findByRiotId(docs: PlayerDoc[], gameName: string, tagLine: string): PlayerDoc | undefined {
  const gn = fold(gameName);
  const tl = fold(tagLine);
  return docs.find((p) => fold(p.game_name) === gn && fold(p.tag_line) === tl);
}

const duplicate = (gameName: string, tagLine: string) =>
  new ApiError(`Le joueur ${gameName}#${tagLine} existe déjà.`, 409);

async function savePlayer(doc: PlayerDoc): Promise<Player> {
  const [stored, { catalog, version }] = await Promise.all([store.put('players', doc), getCatalog()]);
  return toPlayer(stored, catalog, version);
}

function riotFieldsWithTimestamp(fields: RiotFields): RiotFields & { last_synced_at: string } {
  return { ...fields, last_synced_at: utcNowIso() };
}

// ---- players ---------------------------------------------------------------------------------

async function listPlayers(): Promise<Player[]> {
  const [docs, { catalog, version }] = await Promise.all([listPlayerDocs(), getCatalog()]);
  return docs.map((d) => toPlayer(d, catalog, version));
}

async function getPlayer(id: string): Promise<Player> {
  const [doc, { catalog, version }] = await Promise.all([getPlayerDoc(id), getCatalog()]);
  return toPlayer(doc, catalog, version);
}

async function createPlayer(body: CreatePlayerBody): Promise<Player> {
  const rawName = typeof body?.game_name === 'string' ? body.game_name : '';
  const rawTag = typeof body?.tag_line === 'string' ? body.tag_line : '';
  if (rawName.length > 64) throw unprocessable('Le nom de jeu ne peut pas dépasser 64 caractères.');
  if (rawTag.length > 16) throw unprocessable('Le tag ne peut pas dépasser 16 caractères.');
  const gameName = rawName.trim();
  const tagLine = rawTag.trim().replace(/^#+/, '').trim();
  if (!gameName || !tagLine) throw unprocessable('Le nom de jeu et le tag sont obligatoires.');
  const meta = await phpMeta();
  const platform = (body.platform || meta.platform || '').trim().toLowerCase();
  if (!meta.platforms.includes(platform)) {
    throw unprocessable(`Serveur inconnu : ${platform}. Valeurs possibles : ${meta.platforms.join(', ')}.`);
  }
  if (findByRiotId(await listPlayerDocs(), gameName, tagLine)) throw duplicate(gameName, tagLine);

  const doc: PlayerDoc = {
    id: newId(),
    game_name: gameName,
    tag_line: tagLine,
    platform,
    puuid: null,
    profile_icon_id: null,
    summoner_level: null,
    rank: null,
    masteries: [],
    recent: null,
    preferences: emptyPreferences(),
    manual_pool: [],
    last_synced_at: null,
    created_at: utcNowIso(),
  };

  if (meta.riot_configured) {
    const account = await getAccount(gameName, tagLine, platform);
    doc.puuid = account.puuid;
    doc.game_name = account.gameName || gameName;
    doc.tag_line = account.tagLine || tagLine;
    if ((await listPlayerDocs()).some((p) => p.puuid === account.puuid)) throw duplicate(doc.game_name, doc.tag_line);
    const { catalog } = await getCatalog();
    Object.assign(doc, riotFieldsWithTimestamp(await fetchPlayerData(account.puuid, platform, catalog)));
    // Re-check after the (slow) Riot calls to avoid concurrent duplicates.
    const docs = await listPlayerDocs();
    if (docs.some((p) => p.puuid === account.puuid) || findByRiotId(docs, doc.game_name, doc.tag_line)) {
      throw duplicate(doc.game_name, doc.tag_line);
    }
  }
  return savePlayer(doc);
}

async function deletePlayer(id: string): Promise<void> {
  if (!STORE_ID.test(id) || !(await store.remove('players', id))) throw notFound('Joueur introuvable.');
  const teams = await listTeamDocs();
  for (const team of teams) {
    if (team.player_ids.includes(id)) {
      await store.put('teams', { ...team, player_ids: team.player_ids.filter((p) => p !== id) });
    }
  }
}

async function syncPlayer(id: string): Promise<Player> {
  const doc = await getPlayerDoc(id);
  const meta = await phpMeta();
  if (!meta.riot_configured) {
    throw new ApiError('Aucune clé API Riot configurée : impossible de synchroniser ce joueur.', 400);
  }
  const updated: PlayerDoc = { ...doc };
  let puuid = doc.puuid;
  if (!puuid) {
    // Manual player created before a key was configured: resolve the Riot ID now.
    const account = await getAccount(doc.game_name, doc.tag_line, doc.platform);
    puuid = account.puuid;
    const other = (await listPlayerDocs()).find((p) => p.puuid === puuid);
    if (other && other.id !== id) throw duplicate(doc.game_name, doc.tag_line);
    updated.puuid = puuid;
    updated.game_name = account.gameName || doc.game_name;
    updated.tag_line = account.tagLine || doc.tag_line;
  }
  const { catalog } = await getCatalog();
  Object.assign(updated, riotFieldsWithTimestamp(await fetchPlayerData(puuid, doc.platform, catalog)));
  // Merge onto the latest stored version (preferences/pool may have changed meanwhile).
  const latest = (await listPlayerDocs()).find((p) => p.id === id);
  if (!latest) throw notFound('Joueur introuvable.'); // deleted meanwhile
  const { id: _i, preferences: _p, manual_pool: _m, created_at: _c, ...riot } = updated;
  void [_i, _p, _m, _c];
  return savePlayer({ ...latest, ...riot });
}

async function updatePreferences(id: string, body: PlayerPreferences): Promise<Player> {
  const doc = await getPlayerDoc(id);
  const b = (body ?? {}) as Partial<PlayerPreferences>;
  const prefs: PlayerPreferences = {
    roles: asArray<Role>(b.roles),
    wanted_archetypes: asArray<string>(b.wanted_archetypes),
    wanted_champions: asArray<string>(b.wanted_champions),
    avoided_champions: asArray<string>(b.avoided_champions),
  };
  validateRoles(prefs.roles);
  const { catalog } = await getCatalog();
  validateChampions(catalog, [...prefs.wanted_champions, ...prefs.avoided_champions]);
  if (prefs.wanted_archetypes.length) {
    const known = new Set(listArchetypes().map((a) => a.key));
    const unknown = prefs.wanted_archetypes.filter((a) => !known.has(a));
    if (unknown.length) throw unprocessable(`Type de personnage inconnu : ${unknown.join(', ')}.`);
  }
  return savePlayer({
    ...doc,
    preferences: {
      roles: unique(prefs.roles),
      wanted_archetypes: unique(prefs.wanted_archetypes),
      wanted_champions: unique(prefs.wanted_champions),
      avoided_champions: unique(prefs.avoided_champions),
    },
  });
}

async function updatePool(id: string, champions: ManualPoolEntry[]): Promise<Player> {
  const doc = await getPlayerDoc(id);
  const entries = asArray<ManualPoolEntry>(champions);
  for (const e of entries) {
    if (!e || typeof e.champion_id !== 'string') throw unprocessable('Entrée de pool invalide.');
    if (typeof e.comfort !== 'number' || !Number.isFinite(e.comfort) || e.comfort < 0 || e.comfort > 1) {
      throw unprocessable(`Le niveau de confort de ${e.champion_id} doit être compris entre 0 et 1.`);
    }
  }
  const { catalog } = await getCatalog();
  validateChampions(catalog, entries.map((e) => e.champion_id));
  // Last entry wins, kept at its first position (same as the Python dict).
  const dedup = new Map<string, ManualPoolEntry>();
  for (const e of entries) dedup.set(e.champion_id, { champion_id: e.champion_id, comfort: e.comfort });
  return savePlayer({ ...doc, manual_pool: [...dedup.values()] });
}

// ---- teams -----------------------------------------------------------------------------------

export const MAX_TEAM_SIZE = 5;

async function validateTeam(body: TeamBody): Promise<{ name: string; player_ids: string[] }> {
  const rawName = typeof body?.name === 'string' ? body.name : '';
  if (rawName.length > 80) throw unprocessable("Le nom de l'équipe ne peut pas dépasser 80 caractères.");
  const name = rawName.trim();
  if (!name) throw unprocessable("Le nom de l'équipe est obligatoire.");
  const player_ids = unique(asArray<string>(body.player_ids));
  if (player_ids.length > MAX_TEAM_SIZE) {
    throw unprocessable(`Une équipe ne peut pas compter plus de ${MAX_TEAM_SIZE} joueurs.`);
  }
  const known = new Set((await listPlayerDocs()).map((p) => p.id));
  for (const pid of player_ids) if (!known.has(pid)) throw notFound(`Joueur introuvable : ${pid}.`);
  return { name, player_ids };
}

async function getTeam(id: string): Promise<Team> {
  const team = (await listTeamDocs()).find((t) => t.id === id);
  if (!team) throw notFound('Équipe introuvable.');
  return team;
}

async function createTeam(body: TeamBody): Promise<Team> {
  const fields = await validateTeam(body);
  return store.put<Team>('teams', { id: newId(), ...fields, created_at: utcNowIso() });
}

async function updateTeam(id: string, body: TeamBody): Promise<Team> {
  const team = await getTeam(id);
  const fields = await validateTeam(body);
  return store.put<Team>('teams', { ...team, ...fields });
}

async function deleteTeam(id: string): Promise<void> {
  if (!STORE_ID.test(id) || !(await store.remove('teams', id))) throw notFound('Équipe introuvable.');
  for (const comp of await listSavedDocs()) {
    if (comp.team_id === id) await store.put('saved', { ...comp, team_id: null });
  }
}

// ---- compositions ----------------------------------------------------------------------------

function normalizePicks(picks: unknown): Pick[] {
  return asArray<Pick>(picks).map((p) => ({
    role: p?.role,
    champion_id: p?.champion_id,
    player_id: p?.player_id ?? null,
  }));
}

function validatePicks(catalog: ChampionCatalog, picks: Pick[], label = 'La composition'): void {
  if (picks.length > 5) throw unprocessable(`${label} ne peut pas contenir plus de 5 champions.`);
  validateRoles(picks.map((p) => p.role));
  const roles = picks.map((p) => p.role);
  if (new Set(roles).size !== roles.length) {
    throw unprocessable(`${label} contient plusieurs champions sur le même rôle.`);
  }
  const champs = picks.map((p) => p.champion_id);
  if (new Set(champs).size !== champs.length) {
    throw unprocessable(`${label} contient plusieurs fois le même champion.`);
  }
  validateChampions(catalog, champs);
}

/** Fill missing enemy roles: first catalog role not already taken, else any free role. */
export function assignEnemyRoles(enemy: EnemyPick[], catalog: { get: ChampionCatalog['get'] }): Pick[] {
  const taken = new Set<Role>(enemy.filter((e) => e.role).map((e) => e.role as Role));
  return enemy.map((e) => {
    let role = e.role ?? null;
    if (!role) {
      const champ = catalog.get(e.champion_id);
      const candidates = (champ?.roles ?? []).filter((r) => !taken.has(r));
      for (const r of ROLES) if (!taken.has(r) && !candidates.includes(r)) candidates.push(r);
      role = candidates[0];
      if (!role) throw unprocessable("L'équipe adverse ne peut pas contenir plus de 5 champions.");
      taken.add(role);
    }
    return { role, champion_id: e.champion_id };
  });
}

function normalizeOptions(raw: Partial<GenerationOptions> | undefined): Required<GenerationOptions> {
  const o = raw ?? {};
  const options: Required<GenerationOptions> = {
    theme: o.theme ?? null,
    role_assignments: { ...(o.role_assignments ?? {}) },
    locked_picks: { ...(o.locked_picks ?? {}) },
    bans: asArray<string>(o.bans),
    enemy_champions: asArray<string>(o.enemy_champions),
    count: o.count ?? 5,
    exploration: o.exploration ?? 0.2,
  };
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 20) {
    throw unprocessable('Le nombre de suggestions doit être compris entre 1 et 20.');
  }
  if (typeof options.exploration !== 'number' || !(options.exploration >= 0 && options.exploration <= 1)) {
    throw unprocessable("Le niveau d'exploration doit être compris entre 0 et 1.");
  }
  validateRoles(Object.values(options.role_assignments));
  return options;
}

async function generate(body: GenerateBody): Promise<{ suggestions: CompositionSuggestion[] }> {
  const ids = asArray<string>(body?.player_ids);
  if (ids.length < 1 || ids.length > 5) throw unprocessable('Sélectionnez entre 1 et 5 joueurs.');
  if (new Set(ids).size !== ids.length) throw unprocessable('Un joueur est sélectionné plusieurs fois.');
  const [docs, { catalog }] = await Promise.all([listPlayerDocs(), getCatalog()]);
  const rows = ids.map((pid) => {
    const row = docs.find((d) => d.id === pid);
    if (!row) throw notFound(`Joueur introuvable : ${pid}.`);
    return row;
  });

  const opts = normalizeOptions(body.options);
  for (const [mapping, what] of [
    [opts.role_assignments, 'un rôle'],
    [opts.locked_picks, 'un champion'],
  ] as const) {
    const stray = Object.keys(mapping).filter((pid) => !ids.includes(pid));
    if (stray.length) {
      throw unprocessable(`Impossible d'imposer ${what} à un joueur non sélectionné : ${stray.join(', ')}.`);
    }
  }
  const forced = Object.values(opts.role_assignments);
  if (new Set(forced).size !== forced.length) {
    throw unprocessable('Deux joueurs ne peuvent pas être forcés sur le même rôle.');
  }
  const locked = Object.values(opts.locked_picks);
  if (new Set(locked).size !== locked.length) throw unprocessable('Le même champion est imposé à plusieurs joueurs.');
  validateChampions(catalog, [...locked, ...opts.bans, ...opts.enemy_champions]);
  if (opts.theme !== null) {
    const known = new Set(listThemes().map((t) => t.key));
    if (!known.has(opts.theme)) throw unprocessable(`Thème inconnu : ${opts.theme}.`);
  }
  const players = rows.map((row) => toPlayerInput(row, catalog));
  return { suggestions: generateCompositions(players, opts, catalog) };
}

async function gamePlan(picks: Pick[]): Promise<GamePlan> {
  const list = normalizePicks(picks);
  if (!list.length) throw unprocessable('Ajoutez au moins un champion pour obtenir un plan de jeu.');
  const { catalog } = await getCatalog();
  validatePicks(catalog, list);
  return buildGamePlan(list, catalog);
}

async function matchup(body: MatchupBody): Promise<MatchupPlan> {
  const enemyIn = asArray<EnemyPick>(body?.enemy).map((e) => ({ champion_id: e?.champion_id, role: e?.role ?? null }));
  const ally = normalizePicks(body?.ally);
  if (!enemyIn.length) throw unprocessable('Ajoutez au moins un champion adverse.');
  if (enemyIn.length > 5) throw unprocessable("L'équipe adverse ne peut pas contenir plus de 5 champions.");
  const { catalog } = await getCatalog();
  validateChampions(catalog, enemyIn.map((e) => e.champion_id));
  const explicit = enemyIn.filter((e) => e.role !== null).map((e) => e.role);
  validateRoles(explicit);
  if (new Set(explicit).size !== explicit.length) {
    throw unprocessable("L'équipe adverse contient plusieurs champions sur le même rôle.");
  }
  validatePicks(catalog, ally, 'Votre composition');
  const enemy = assignEnemyRoles(enemyIn, catalog);
  validatePicks(catalog, enemy, "L'équipe adverse");
  return buildMatchupPlan(ally, enemy, catalog);
}

async function listSaved(): Promise<SavedComposition[]> {
  const docs = await listSavedDocs();
  // Newest first (created_at DESC, then reverse insertion order), like the old backend.
  return docs
    .map((d, i) => [d, i] as const)
    .sort(([a, ia], [b, ib]) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : ib - ia))
    .map(([d]) => d);
}

async function saveComposition(body: SaveCompositionBody): Promise<SavedComposition> {
  const rawName = typeof body?.name === 'string' ? body.name : '';
  if (rawName.length > 120) throw unprocessable('Le nom de la composition ne peut pas dépasser 120 caractères.');
  const name = rawName.trim();
  if (!name) throw unprocessable('Le nom de la composition est obligatoire.');
  const picks = normalizePicks(body.picks);
  if (!picks.length) throw unprocessable('Une composition sauvegardée doit contenir au moins un champion.');
  const { catalog } = await getCatalog();
  validatePicks(catalog, picks);
  const teamId = body.team_id ?? null;
  if (teamId !== null && !(await listTeamDocs()).some((t) => t.id === teamId)) throw notFound('Équipe introuvable.');
  return store.put<SavedComposition>('saved', {
    id: newId(),
    name,
    team_id: teamId,
    theme: body.theme ?? null,
    picks,
    notes: body.notes ?? null,
    created_at: utcNowIso(),
  });
}

async function deleteSaved(id: string): Promise<void> {
  if (!STORE_ID.test(id) || !(await store.remove('saved', id))) throw notFound('Composition introuvable.');
}

// ---- static data -----------------------------------------------------------------------------

async function meta(): Promise<Meta> {
  const [m, { version }] = await Promise.all([phpMeta(), getCatalog()]);
  return { ...m, ddragon_version: version };
}

async function champions(): Promise<ChampionInfo[]> {
  const { catalog } = await getCatalog();
  return [...catalog.all()].sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
}

export const localApi = {
  health: async (): Promise<{ status: string }> => {
    await backendRequest('GET', 'meta');
    return { status: 'ok' };
  },
  meta,
  champions,
  archetypes: async (): Promise<ArchetypeInfo[]> => listArchetypes(),
  themes: async (): Promise<ThemeInfo[]> => listThemes(),

  listPlayers,
  getPlayer,
  createPlayer,
  deletePlayer,
  syncPlayer,
  updatePreferences,
  updatePool,

  listTeams: (): Promise<Team[]> => listTeamDocs(),
  getTeam,
  createTeam,
  updateTeam,
  deleteTeam,

  generate,
  gamePlan,
  matchup,
  listSaved,
  saveComposition,
  deleteSaved,
};
