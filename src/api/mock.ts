// Dev-only in-memory backend, enabled with VITE_MOCK=1. Never bundled in production builds
// (client.ts imports it dynamically behind a compile-time constant).
import { ApiError } from './client';
import type {
  ArchetypeInfo,
  ChampionInfo,
  ChampionTraits,
  CompositionSuggestion,
  DamageType,
  DraftAdvice,
  DraftEnemyAccount,
  DraftInput,
  DraftState,
  EnemyPlayerInsight,
  EnemyPlayerProfile,
  EnemyRolePrediction,
  PhaseAttention,
  PlaystyleStats,
  PlayerInput,
  PlayerPickAdvice,
  GamePlan,
  GenerateBody,
  MatchupBody,
  MatchupPlan,
  Pick,
  Player,
  PlayerPreferences,
  PoolEntry,
  Role,
  SavedComposition,
  Team,
  ThemeInfo,
  TimelineStyle,
} from './types';
import { ROLES } from './types';
import type { ClashFetcher } from './clash';
import type { RiotKeyLimits } from './riotLimits';
import type { ChampionCatalog } from '../engine';
import type { LiveDraft } from './draft';
import type { DetectedGame } from './spectator';
import type { ProfileProgress, ProfileRequest } from './enemyProfile';
import type { CollectResult, MetaStatus } from './meta';
import type { GamesWins, MetaStats, MetaTier } from './types';
import { META_TIERS } from './types';
import type { MetaTierProgress } from './metaRank';

const ZERO: ChampionTraits = {
  engage: 0, peel: 0, poke: 0, waveclear: 0, splitpush: 0, pick: 0, teamfight: 0,
  early: 0, late: 0, mobility: 0, frontline: 0, cc: 0, sustain: 0, objective: 0,
};

function portrait(letter: string, hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,45%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},60%,22%)"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><text x="32" y="42" font-family="Georgia,serif" font-size="30" text-anchor="middle" fill="rgba(255,255,255,.85)">${letter}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function champ(
  id: string, key: number, name: string, title: string, roles: Role[], archetype: string,
  damage_type: DamageType, region: string, groups: string[], tags: string[],
  traits: Partial<ChampionTraits>, withImage = true,
): ChampionInfo {
  return {
    id, key, name, title, roles, archetype, damage_type, region, groups, tags,
    image_url: withImage ? portrait(name[0], (key * 47) % 360) : '',
    traits: { ...ZERO, ...traits },
  };
}

const CHAMPIONS: ChampionInfo[] = [
  champ('Ahri', 103, 'Ahri', 'Renarde à neuf queues', ['MID'], 'burst_mage', 'AP', 'ionia', ['vastaya'], ['Mage', 'Assassin'], { pick: 3, mobility: 3, cc: 2 }),
  champ('Amumu', 32, 'Amumu', 'Momie mélancolique', ['JUNGLE', 'SUPPORT'], 'tank', 'AP', 'shurima', ['yordle', 'undead'], ['Tank', 'Mage'], { engage: 3, teamfight: 3, cc: 3, frontline: 3 }, false),
  champ('Annie', 1, 'Annie', "L'enfant des ténèbres", ['MID', 'SUPPORT'], 'burst_mage', 'AP', 'noxus', [], ['Mage'], { engage: 2, teamfight: 2, cc: 2 }),
  champ('Caitlyn', 51, 'Caitlyn', 'Shérif de Piltover', ['BOTTOM'], 'marksman', 'AD', 'piltover', [], ['Marksman'], { poke: 3, early: 2, objective: 2 }),
  champ('Darius', 122, 'Darius', 'Main de Noxus', ['TOP'], 'juggernaut', 'AD', 'noxus', [], ['Fighter', 'Tank'], { early: 3, frontline: 2, sustain: 2 }),
  champ('Draven', 119, 'Draven', 'Glorieux exécuteur', ['BOTTOM'], 'marksman', 'AD', 'noxus', [], ['Marksman'], { early: 3 }),
  champ('Jinx', 222, 'Jinx', 'La gâchette folle', ['BOTTOM'], 'marksman', 'AD', 'zaun', [], ['Marksman'], { late: 3, teamfight: 3 }),
  champ('Leona', 89, 'Leona', "L'aube radieuse", ['SUPPORT'], 'tank', 'AD', 'targon', [], ['Tank', 'Support'], { engage: 3, cc: 3, frontline: 2 }),
  champ('Lulu', 117, 'Lulu', 'Sorcière féerique', ['SUPPORT', 'MID'], 'enchanter', 'AP', 'bandle', ['yordle'], ['Support', 'Mage'], { peel: 3, poke: 1 }),
  champ('Malphite', 54, 'Malphite', 'Éclat du Monolithe', ['TOP', 'SUPPORT'], 'tank', 'AP', 'ixtal', [], ['Tank', 'Fighter'], { engage: 3, teamfight: 3, frontline: 3, cc: 2 }, false),
  champ('MonkeyKing', 62, 'Wukong', 'Le roi des singes', ['TOP', 'JUNGLE'], 'diver', 'AD', 'ionia', ['vastaya'], ['Fighter', 'Tank'], { engage: 2, teamfight: 3 }),
  champ('Orianna', 61, 'Orianna', 'La demoiselle mécanique', ['MID'], 'control_mage', 'AP', 'piltover', [], ['Mage', 'Support'], { teamfight: 3, waveclear: 3, peel: 2 }),
  champ('Sett', 875, 'Sett', 'Le Boss', ['TOP', 'SUPPORT'], 'juggernaut', 'AD', 'ionia', ['vastaya'], ['Fighter', 'Tank'], { engage: 2, frontline: 2 }),
  champ('Swain', 50, 'Swain', 'Grand général de Noxus', ['MID', 'SUPPORT', 'TOP'], 'control_mage', 'AP', 'noxus', [], ['Mage', 'Fighter'], { sustain: 3, teamfight: 2 }),
  champ('Teemo', 17, 'Teemo', 'Scout de Bandle', ['TOP'], 'specialist', 'AP', 'bandle', ['yordle'], ['Marksman', 'Assassin'], { poke: 2, splitpush: 2 }),
  champ('Thresh', 412, 'Thresh', 'Le gardien des chaînes', ['SUPPORT'], 'catcher', 'AD', 'shadow_isles', ['undead'], ['Support', 'Fighter'], { pick: 3, peel: 2, cc: 3 }),
  champ('Tristana', 18, 'Tristana', 'Canonnière yordle', ['BOTTOM', 'MID'], 'marksman', 'AD', 'bandle', ['yordle'], ['Marksman', 'Assassin'], { late: 2, objective: 3 }),
  champ('Vi', 254, 'Vi', 'Massacreuse de Piltover', ['JUNGLE'], 'diver', 'AD', 'piltover', [], ['Fighter', 'Assassin'], { engage: 2, pick: 3 }),
  champ('Veigar', 45, 'Veigar', 'Petit maître du mal', ['MID'], 'burst_mage', 'AP', 'bandle', ['yordle'], ['Mage'], { late: 3, cc: 2 }, false),
  champ('Zed', 238, 'Zed', 'Maître des ombres', ['MID'], 'assassin', 'AD', 'ionia', [], ['Assassin'], { pick: 3, mobility: 3, splitpush: 2 }),
  champ('Sejuani', 113, 'Sejuani', 'Courroux de l’hiver', ['JUNGLE'], 'tank', 'AD', 'freljord', [], ['Tank'], { engage: 3, frontline: 3, cc: 3 }),
  champ('Kaisa', 145, "Kai'Sa", 'Fille du Néant', ['BOTTOM'], 'marksman', 'MIXED', 'void', ['void'], ['Marksman'], { late: 2, mobility: 2 }),
].sort((a, b) => a.name.localeCompare(b.name, 'fr'));

const ARCHETYPES: ArchetypeInfo[] = [
  { key: 'tank', label: 'Tank', description: 'Encaisse les dégâts et lance les combats. Idéal pour protéger ton équipe.' },
  { key: 'juggernaut', label: 'Mastodonte', description: 'Combattant résistant au corps à corps, très fort en duel mais peu mobile.' },
  { key: 'diver', label: 'Plongeur', description: 'Saute sur les cibles fragiles à l’arrière de l’équipe adverse.' },
  { key: 'assassin', label: 'Assassin', description: 'Élimine rapidement une cible isolée puis s’échappe.' },
  { key: 'burst_mage', label: 'Mage burst', description: 'Inflige énormément de dégâts magiques en un seul combo.' },
  { key: 'control_mage', label: 'Mage de contrôle', description: 'Contrôle les zones et les combats d’équipe sur la durée.' },
  { key: 'marksman', label: 'Tireur', description: 'Dégâts constants à distance, devient très fort en fin de partie.' },
  { key: 'enchanter', label: 'Enchanteur', description: 'Soigne, protège et renforce ses alliés.' },
  { key: 'catcher', label: 'Attrapeur', description: 'Attrape un adversaire mal placé grâce à des contrôles à longue portée.' },
  { key: 'specialist', label: 'Spécialiste', description: 'Champion atypique au style de jeu unique.' },
];

const THEMES: ThemeInfo[] = [
  { key: 'engage', label: 'Engage massif', kind: 'playstyle', description: 'Foncer dans le tas avec beaucoup de contrôles et gagner les combats à 5.' },
  { key: 'poke', label: 'Poke & siège', kind: 'playstyle', description: 'User l’adversaire à distance avant d’attaquer les tours.' },
  { key: 'protect', label: 'Protéger le carry', kind: 'playstyle', description: 'Tout miser sur un tireur hyper protégé.' },
  { key: 'pick', label: 'Chasse aux proies', kind: 'playstyle', description: 'Attraper les adversaires isolés et jouer en surnombre.' },
  { key: 'splitpush', label: 'Split push', kind: 'playstyle', description: 'Pression sur les lanes latérales pendant que l’équipe tient le milieu.' },
  { key: 'early', label: 'Snowball early', kind: 'playstyle', description: 'Prendre l’avantage tôt et finir vite.' },
  { key: 'yordle', label: 'Full Yordles', kind: 'thematic', description: 'Les petits mais costauds de Bandle.' },
  { key: 'noxus', label: 'Gloire à Noxus', kind: 'thematic', description: 'Une équipe 100 % noxienne.' },
  { key: 'full_ap', label: 'Full AP', kind: 'thematic', description: 'Que des dégâts magiques, bon courage pour l’armure !' },
  { key: 'piltover', label: 'Piltover & Zaun', kind: 'thematic', description: 'La cité du progrès et ses bas-fonds.' },
];

function prefs(p: Partial<PlayerPreferences>): PlayerPreferences {
  return { roles: [], wanted_archetypes: [], wanted_champions: [], avoided_champions: [], ...p };
}

let players: Player[] = [
  {
    id: 'p1', game_name: 'Lucas', tag_line: 'EUW', platform: 'euw1', puuid: 'puuid-1',
    profile_icon_url: portrait('L', 210), summoner_level: 187,
    rank: { queue: 'RANKED_SOLO_5x5', tier: 'GOLD', division: 'II', lp: 54, wins: 30, losses: 25 },
    last_synced_at: '2026-10-04T18:22:00Z',
    preferences: prefs({ roles: ['MID', 'SUPPORT'], wanted_archetypes: ['control_mage', 'burst_mage'], wanted_champions: ['Orianna'], avoided_champions: ['Teemo'] }),
    masteries: [
      { champion_id: 'Ahri', level: 7, points: 184_220, last_play_time: 1759600000000 },
      { champion_id: 'Annie', level: 6, points: 96_540 },
      { champion_id: 'Lulu', level: 5, points: 41_200 },
      { champion_id: 'Veigar', level: 4, points: 22_100 },
    ],
    recent: {
      games: 20, roles: { TOP: 0, JUNGLE: 1, MID: 13, BOTTOM: 0, SUPPORT: 6 },
      champions: [
        { champion_id: 'Ahri', games: 9, wins: 6, kills: 7.4, deaths: 3.1, assists: 6.2, role: 'MID' },
        { champion_id: 'Lulu', games: 6, wins: 3, kills: 1.2, deaths: 2.8, assists: 14.5, role: 'SUPPORT' },
        { champion_id: 'Annie', games: 4, wins: 2, kills: 5, deaths: 4.5, assists: 7, role: 'MID' },
        { champion_id: 'Vi', games: 1, wins: 0, kills: 2, deaths: 6, assists: 3, role: 'JUNGLE' },
      ],
    },
    manual_pool: [],
    pool: [
      { champion_id: 'Ahri', comfort: 0.95, desire: 0.8, sources: ['mastery', 'recent'] },
      { champion_id: 'Annie', comfort: 0.72, desire: 0.75, sources: ['mastery', 'recent'] },
      { champion_id: 'Lulu', comfort: 0.6, desire: 0.5, sources: ['mastery', 'recent'] },
      { champion_id: 'Orianna', comfort: 0.15, desire: 1, sources: ['wanted'] },
      { champion_id: 'Veigar', comfort: 0.4, desire: 0.55, sources: ['mastery'] },
    ],
  },
  {
    id: 'p2', game_name: 'Méga Tank du 92', tag_line: '1234', platform: 'euw1', puuid: 'puuid-2',
    profile_icon_url: '', summoner_level: 342, rank: { queue: 'RANKED_SOLO_5x5', tier: 'PLATINUM', division: 'IV', lp: 12, wins: 41, losses: 39 }, last_synced_at: '2026-10-01T09:00:00Z',
    preferences: prefs({ roles: ['TOP', 'JUNGLE'], wanted_archetypes: ['tank', 'juggernaut'] }),
    masteries: [
      { champion_id: 'Malphite', level: 7, points: 251_000 },
      { champion_id: 'Darius', level: 7, points: 140_300 },
      { champion_id: 'Sejuani', level: 5, points: 51_000 },
      { champion_id: 'Amumu', level: 5, points: 40_000 },
    ],
    recent: {
      games: 18, roles: { TOP: 11, JUNGLE: 7, MID: 0, BOTTOM: 0, SUPPORT: 0 },
      champions: [
        { champion_id: 'Malphite', games: 8, wins: 5, kills: 3.5, deaths: 4, assists: 9, role: 'TOP' },
        { champion_id: 'Sejuani', games: 7, wins: 4, kills: 2.8, deaths: 3.3, assists: 11, role: 'JUNGLE' },
        { champion_id: 'Darius', games: 3, wins: 1, kills: 6, deaths: 7, assists: 3, role: 'TOP' },
      ],
    },
    manual_pool: [],
    pool: [
      { champion_id: 'Malphite', comfort: 0.98, desire: 0.85, sources: ['mastery', 'recent'] },
      { champion_id: 'Sejuani', comfort: 0.8, desire: 0.8, sources: ['mastery', 'recent'] },
      { champion_id: 'Darius', comfort: 0.75, desire: 0.7, sources: ['mastery', 'recent'] },
      { champion_id: 'Amumu', comfort: 0.55, desire: 0.75, sources: ['mastery'] },
    ],
  },
  {
    id: 'p3', game_name: 'Zoé', tag_line: 'FUN', platform: 'euw1', puuid: null,
    profile_icon_url: '', summoner_level: null, rank: null, last_synced_at: null,
    preferences: prefs({ roles: ['BOTTOM'], wanted_archetypes: ['marksman'], wanted_champions: ['Jinx'] }),
    masteries: [],
    recent: { games: 0, roles: {}, champions: [] },
    manual_pool: [
      { champion_id: 'Caitlyn', comfort: 0.7 },
      { champion_id: 'Tristana', comfort: 0.5 },
    ],
    pool: [
      { champion_id: 'Caitlyn', comfort: 0.7, desire: 0.6, sources: ['manual'] },
      { champion_id: 'Jinx', comfort: 0.2, desire: 1, sources: ['wanted'] },
      { champion_id: 'Tristana', comfort: 0.5, desire: 0.6, sources: ['manual'] },
    ],
  },
];

let teams: Team[] = [
  { id: 't1', name: 'Les potes du jeudi', player_ids: ['p1', 'p2', 'p3'], created_at: '2026-09-20T20:00:00Z' },
];

let saved: SavedComposition[] = [
  {
    id: 's1', name: 'Wombo combo du jeudi', team_id: 't1', theme: 'engage',
    picks: [
      { role: 'TOP', champion_id: 'Malphite', player_id: 'p2' },
      { role: 'MID', champion_id: 'Orianna', player_id: 'p1' },
      { role: 'BOTTOM', champion_id: 'Jinx', player_id: 'p3' },
    ],
    notes: 'Malphite R + Orianna R = gg', created_at: '2026-09-28T21:10:00Z',
  },
];

const META = {
  ddragon_version: '15.19.1', riot_configured: false, platform: 'euw1', region: 'europe',
  platforms: ['euw1', 'eun1', 'na1', 'kr', 'br1', 'jp1', 'la1', 'la2', 'oc1', 'tr1', 'ru', 'me1', 'sg2', 'tw2', 'vn2'],
  // Fake high-elo meta summary (the real one comes from the PHP cron collector).
  meta_stats: { patch: '16.19', games: 4213, updated_at: '2026-10-10T12:00:00Z' },
};

let seq = 100;
const uid = (p: string) => `${p}${++seq}`;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const champById = (id: string) => CHAMPIONS.find((c) => c.id === id);
const champName = (id: string) => champById(id)?.name ?? id;

function recomputePool(p: Player) {
  const map = new Map<string, PoolEntry>();
  for (const m of p.masteries) {
    map.set(m.champion_id, { champion_id: m.champion_id, comfort: Math.min(1, m.points / 200_000), desire: 0.5, sources: ['mastery'] });
  }
  for (const r of p.recent.champions) {
    const e = map.get(r.champion_id) ?? { champion_id: r.champion_id, comfort: 0, desire: 0.5, sources: [] };
    e.comfort = Math.min(1, e.comfort + r.games / 15);
    if (!e.sources.includes('recent')) e.sources.push('recent');
    map.set(r.champion_id, e);
  }
  for (const m of p.manual_pool) {
    const e = map.get(m.champion_id) ?? { champion_id: m.champion_id, comfort: 0, desire: 0.5, sources: [] };
    e.comfort = Math.max(e.comfort, m.comfort);
    e.sources.push('manual');
    map.set(m.champion_id, e);
  }
  for (const id of p.preferences.wanted_champions) {
    const e = map.get(id) ?? { champion_id: id, comfort: 0.1, desire: 0.5, sources: [] };
    e.desire = 1;
    e.sources.push('wanted');
    map.set(id, e);
  }
  for (const e of map.values()) {
    const c = champById(e.champion_id);
    if (c && p.preferences.wanted_archetypes.includes(c.archetype)) e.desire = Math.max(e.desire, 0.75);
    if (p.preferences.avoided_champions.includes(e.champion_id)) e.desire = 0;
    e.comfort = Math.round(e.comfort * 100) / 100;
  }
  p.pool = [...map.values()].sort((a, b) => b.comfort - a.comfort);
}

function generate(body: GenerateBody): { suggestions: CompositionSuggestion[] } {
  const ps = body.player_ids.map((id) => players.find((p) => p.id === id)).filter((p): p is Player => !!p);
  if (!ps.length) throw new ApiError('Aucun joueur valide sélectionné.', 400);
  const o = body.options;
  const themes = o.theme ? THEMES.filter((t) => t.key === o.theme) : THEMES.slice(0, 6);
  const count = o.count ?? 5;
  const out: CompositionSuggestion[] = [];
  for (let i = 0; i < count; i++) {
    const theme = themes[i % themes.length];
    const used = new Set<string>(o.bans ?? []);
    const usedRoles = new Set<Role>();
    const picks = ps.map((p, idx) => {
      const role: Role = o.role_assignments?.[p.id]
        ?? p.preferences.roles.find((r) => !usedRoles.has(r))
        ?? ROLES.find((r) => !usedRoles.has(r))!;
      usedRoles.add(role);
      const locked = o.locked_picks?.[p.id];
      const candidates = p.pool.filter((e) => !used.has(e.champion_id) && champById(e.champion_id)?.roles.includes(role));
      const entry = locked
        ? p.pool.find((e) => e.champion_id === locked) ?? { champion_id: locked, comfort: 0.3, desire: 0.5, sources: [] }
        : candidates[(i + idx) % Math.max(1, candidates.length)];
      const champion_id = entry?.champion_id ?? CHAMPIONS.find((c) => c.roles.includes(role) && !used.has(c.id))!.id;
      used.add(champion_id);
      const comfort = entry?.comfort ?? 0.1;
      const desire = entry?.desire ?? 0.4;
      const reasons = [
        comfort > 0.6 ? `${p.game_name} maîtrise bien ${champName(champion_id)}` : `Nouveau champion à découvrir pour ${p.game_name}`,
        `Colle au thème « ${theme.label} »`,
      ];
      if (locked) reasons.unshift('Champion verrouillé');
      return { role, champion_id, player_id: p.id, comfort, desire, reasons };
    });
    const avgC = picks.reduce((s, x) => s + x.comfort, 0) / picks.length;
    const avgD = picks.reduce((s, x) => s + x.desire, 0) / picks.length;
    const breakdown = {
      comfort: Math.round(avgC * 100), desire: Math.round(avgD * 100),
      theme_fit: 85 - i * 7, balance: 70 + ((i * 13) % 25),
      counter: o.enemy_champions?.length ? 62 - i * 3 : null,
      meta: 68 - ((i * 11) % 30),
    };
    out.push({
      theme: theme.key, theme_label: theme.label,
      score: Math.round((breakdown.comfort + breakdown.desire + breakdown.theme_fit + breakdown.balance) / 4 * 10) / 10,
      breakdown, picks,
      strengths: ['Gros potentiel de teamfight', 'Beaucoup de contrôles de foule'].slice(0, 2 - (i % 2)),
      warnings: i % 2 === 0 ? ['Peu de dégâts physiques : l’adversaire peut empiler la résistance magique'] : [],
    });
  }
  return { suggestions: out.sort((a, b) => b.score - a.score) };
}

function gamePlan(picks: Pick[]): GamePlan {
  return {
    identity: 'Composition d’engage : on force les combats à 5 autour des objectifs grâce à des ultimes de zone.',
    detected_themes: ['engage', 'protect'],
    win_conditions: [
      'Gagner les combats d’équipe autour du Drake et du Nashor',
      'Enchaîner les ultimes de zone (Malphite → Orianna)',
      'Garder le tireur en vie pendant les combats',
    ],
    phases: [
      { phase: 'early', summary: 'Jouer safe en lane et aider le jungler sur les escarmouches de rivière.', tips: ['Prioriser la vision du côté bot', 'Ne pas forcer de combats avant le niveau 6'] },
      { phase: 'mid', summary: 'Grouper pour les objectifs dès les ultimes disponibles.', tips: ['Prendre les drakes avec l’avantage numérique', 'Placer des balises de contrôle autour du Héraut'] },
      { phase: 'late', summary: 'Rester groupés et chercher l’engage parfait.', tips: ['Ne jamais se faire prendre isolé', 'Jouer autour du cooldown des ultimes'] },
    ],
    power_spikes: ['Niveau 6 : ultimes d’engage disponibles', '2 objets sur le mid laner', '3 objets sur le tireur'],
    key_combos: ['Malphite R → Orianna R (Onde de choc)', 'Sejuani R → Ahri charme'],
    objectives: ['Drakes en priorité', 'Héraut pour ouvrir le mid', 'Nashor après un combat gagné'],
    role_tips: picks.map((p) => ({
      role: p.role, champion_id: p.champion_id,
      tips: [`Avec ${champName(p.champion_id)}, reste proche de ton équipe.`, 'Garde ton sort d’invocateur défensif pour les plongeons.'],
    })),
    avoid: ['Se battre sans vision', 'Engager quand les ultimes sont en recharge', 'Split push sans couverture'],
    damage_profile: (() => {
      const counts: Record<string, number> = { AD: 0, AP: 0, MIXED: 0 };
      for (const p of picks) counts[champById(p.champion_id)?.damage_type ?? 'AD'] += 1;
      const n = picks.length || 1;
      return { AD: counts.AD / n, AP: counts.AP / n, MIXED: counts.MIXED / n };
    })(),
  };
}

function matchup(body: MatchupBody): MatchupPlan {
  if (!body.enemy.length) throw new ApiError('Ajoute au moins un champion adverse.', 400);
  const enemy = body.enemy.map((e, i) => ({ ...e, role: e.role ?? champById(e.champion_id)?.roles[0] ?? ROLES[i % 5] }));
  return {
    enemy_identity: 'Composition de poke : ils veulent vous user à distance avant d’engager.',
    enemy_themes: ['poke', 'pick'],
    enemy_win_conditions: ['Assiéger les tours avec du poke', 'Attraper un joueur isolé avant un objectif'],
    how_to_win: ['Engager vite et fort : leur compo n’aime pas les combats rapprochés', 'Contourner par les flancs pour atteindre les carrys', 'Forcer les objectifs quand leur poke est en recharge'],
    threats: enemy.slice(0, 3).map((e, i) => ({
      champion_id: e.champion_id, danger: 3 - i,
      why: `${champName(e.champion_id)} peut ${i === 0 ? 'one-shot un carry' : 'contrôler les combats'}.`,
      how_to_handle: i === 0 ? 'Le focus dès le début du combat, garder les contrôles pour lui.' : 'Respecter sa portée et attendre ses compétences clés.',
    })),
    lane_matchups: body.ally.flatMap((a) => {
      const e = enemy.find((x) => x.role === a.role);
      return e ? [{ role: a.role, ally_champion_id: a.champion_id, enemy_champion_id: e.champion_id, advice: `Joue autour de tes niveaux de puissance face à ${champName(e.champion_id)}.` }] : [];
    }),
    objectives: ['Prendre le Héraut tôt pour casser leur siège', 'Contester les drakes avec priorité de lane'],
    suggested_bans: enemy.slice(0, 2).map((e) => e.champion_id),
    ...(body.enemy_profiles?.length
      ? { enemy_players: body.enemy_profiles.map((p) => mockInsight(p)), attention: mockAttention(body.enemy_profiles) }
      : {}),
  };
}

// ---- live draft (demo) ------------------------------------------------------------------------

const drafts = new Map<string, DraftState>([
  ['team-t1', {
    id: 'team-t1', team_id: 't1', player_ids: ['p1', 'p2', 'p3'], source: 'manual', phase: 'pick', side: 'blue',
    ally_bans: ['Teemo', 'Draven', 'Sett'], enemy_bans: ['Thresh', 'Kaisa'],
    ally: [
      { player_id: 'p2', champion_id: 'Malphite', role: 'TOP', locked: true },
      { player_id: null, champion_id: 'Vi', role: 'JUNGLE', locked: true },
      { player_id: 'p1', champion_id: 'Ahri', role: 'MID', locked: false },
      { player_id: 'p3', champion_id: null, role: 'BOTTOM', locked: false },
      { player_id: null, champion_id: null, role: 'SUPPORT', locked: false },
    ],
    enemy: [
      { champion_id: 'Zed', role: 'MID', locked: true },
      { champion_id: 'Darius', role: null, locked: true },
      { champion_id: 'Leona', role: null, locked: true },
      { champion_id: null, role: null, locked: false },
      { champion_id: null, role: null, locked: false },
    ],
    enemy_accounts: [], game_id: null, updated_at: '2026-11-10T20:00:00.000Z',
  }],
]);

/** Fake companion data, only when localStorage "lolhelper:mock-live" is "1" (demo of the sync). */
function mockLive(ids: string[]): LiveDraft | null {
  let flag: string | null = null;
  try {
    flag = window.localStorage.getItem('lolhelper:mock-live');
  } catch {
    flag = null;
  }
  // "1" = ranked (enemies anonymous), "clash" = the client reveals the enemy players.
  const clash = flag === 'clash';
  if ((flag !== '1' && !clash) || !ids.includes('p1')) return null;
  const reveal = (puuid: string) => (clash ? puuid : '');
  const now = new Date().toISOString();
  return {
    version: 1, puuid: 'puuid-1', phase: 'ban_pick', queue_id: clash ? 700 : 420, local_cell: 2,
    my_team: [
      { cell: 0, puuid: 'puuid-2', champion_key: 54, intent_key: 0, position: 'top' },
      { cell: 1, puuid: '', champion_key: 113, intent_key: 0, position: 'jungle' },
      { cell: 2, puuid: '', champion_key: 61, intent_key: 0, position: 'middle' },
      { cell: 3, puuid: '', champion_key: 0, intent_key: 51, position: 'bottom' },
      { cell: 4, puuid: '', champion_key: 0, intent_key: 0, position: 'utility' },
    ],
    their_team: [
      { cell: 5, puuid: reveal('enemy-Zed'), champion_key: 238 }, { cell: 6, puuid: reveal('enemy-Darius'), champion_key: 122 },
      { cell: 7, puuid: reveal('enemy-Leona'), champion_key: 89 },
      { cell: 8, puuid: reveal('enemy-Sejuani'), champion_key: 0 }, { cell: 9, puuid: reveal('enemy-Jinx'), champion_key: 0 },
    ],
    bans: { mine: [17, 119, 875], theirs: [412, 145] },
    actions: [
      { type: 'pick', champion_key: 54, completed: true, ally: true, cell: 0, in_progress: false },
      { type: 'pick', champion_key: 238, completed: true, ally: false, cell: 5, in_progress: false },
      { type: 'pick', champion_key: 122, completed: true, ally: false, cell: 6, in_progress: false },
      { type: 'pick', champion_key: 113, completed: true, ally: true, cell: 1, in_progress: false },
      { type: 'pick', champion_key: 61, completed: false, ally: true, cell: 2, in_progress: true },
      { type: 'pick', champion_key: 89, completed: true, ally: false, cell: 7, in_progress: false },
    ],
    timer_remaining_ms: 21000, sent_at: now, player_id: 'p1', received_at: now,
  };
}

function mockDetect(friends: { player_id: string }[]): DetectedGame {
  const ids = friends.map((f) => f.player_id);
  const acc = (riot_id: string, champion_id: string, tier: string, points: number, otp = false): DraftEnemyAccount => ({
    puuid: `enemy-${champion_id}`, riot_id, champion_id, role: null,
    rank: { queue: 'RANKED_SOLO_5x5', tier, division: 'II', lp: 40, wins: 61, losses: 50 },
    champion_mastery: { champion_id, level: otp ? 7 : 5, points },
    masteries: [{ champion_id, level: otp ? 7 : 5, points }],
  });
  return {
    game_id: 7123456789, queue_id: 420, side: 'blue',
    ally: [
      { player_id: ids.includes('p2') ? 'p2' : null, champion_id: 'Malphite', role: null, locked: true },
      { player_id: null, champion_id: 'Vi', role: null, locked: true },
      { player_id: ids.includes('p1') ? 'p1' : null, champion_id: 'Ahri', role: null, locked: true },
      { player_id: ids.includes('p3') ? 'p3' : null, champion_id: 'Caitlyn', role: null, locked: true },
      { player_id: null, champion_id: 'Lulu', role: null, locked: true },
    ],
    enemy: ['Zed', 'Darius', 'Leona', 'Sejuani', 'Jinx'].map((c) => ({ champion_id: c, role: null, locked: true, puuid: `enemy-${c}` })),
    ally_bans: ['Teemo', 'Draven', 'Sett'], enemy_bans: ['Thresh', 'Kaisa'],
    enemy_accounts: [
      acc('OmbreDuMid#EUW', 'Zed', 'PLATINUM', 612_000, true),
      acc('Hache Rouge#1337', 'Darius', 'GOLD', 88_000),
      acc('Aube#SUN', 'Leona', 'GOLD', 140_500),
      acc('Glace#FRJ', 'Sejuani', 'SILVER', 23_000),
      acc('Gâchette#ZAU', 'Jinx', 'GOLD', 54_000),
    ],
  };
}

export function mockCatalog(): ChampionCatalog {
  return {
    get: (id) => CHAMPIONS.find((c) => c.id === id),
    byKey: (key) => CHAMPIONS.find((c) => c.key === Number(key)),
    all: () => CHAMPIONS,
  };
}

/** Plausible advice for the demo (the real one comes from the engine's recommendDraft). */
export function mockDraftAdvice(players: PlayerInput[], input: DraftInput): DraftAdvice {
  const used = new Set<string>([
    ...input.bans,
    ...input.enemy.map((s) => s.champion_id).filter((c): c is string => !!c),
  ]);
  const lockedAlly = new Set(input.ally.filter((s) => s.locked && s.champion_id).map((s) => s.champion_id as string));
  const enemyIds = input.enemy.map((s) => s.champion_id).filter((c): c is string => !!c);
  const takenRoles = new Set(input.ally.filter((s) => s.role && s.locked).map((s) => s.role as Role));
  const advice: PlayerPickAdvice[] = [];
  for (const slot of input.ally) {
    const p = players.find((x) => x.player_id === slot.player_id);
    if (!p) continue;
    if (slot.locked && slot.champion_id) {
      advice.push({ player_id: p.player_id, role: slot.role ?? null, locked_champion_id: slot.champion_id, picks: [] });
      continue;
    }
    const role: Role = slot.role ?? p.preferences.roles.find((r) => !takenRoles.has(r)) ?? ROLES.find((r) => !takenRoles.has(r)) ?? 'MID';
    takenRoles.add(role);
    const own = p.pool.filter((e) => !used.has(e.champion_id) && !lockedAlly.has(e.champion_id) && champById(e.champion_id)?.roles.includes(role));
    const extra = CHAMPIONS.filter((c) => c.roles.includes(role) && !used.has(c.id) && !lockedAlly.has(c.id) && !own.some((e) => e.champion_id === c.id))
      .map((c) => ({ champion_id: c.id, comfort: 0.12, desire: 0.4, sources: [] }));
    const picks = [...own, ...extra].slice(0, 4).map((e, i) => {
      const reasons: string[] = [];
      if (e.comfort >= 0.6) reasons.push(`Champion maîtrisé (${Math.round(e.comfort * 190)}k points)`);
      else if (e.comfort < 0.2) reasons.push('Pick méta solide sur ce patch, peu joué par toi');
      if (enemyIds.includes('Zed') && ['Malphite', 'Lulu', 'Annie', 'Orianna'].includes(e.champion_id)) reasons.push('Bon contre Zed (duel favorable sur ce patch)');
      if (champById(e.champion_id)?.traits.frontline) reasons.push('Complète la frontline');
      if (champById(e.champion_id)?.damage_type === 'AP') reasons.push('Apporte des dégâts magiques à une équipe surtout physique');
      if (!reasons.length) reasons.push('Bonne synergie avec vos champions verrouillés');
      return { champion_id: e.champion_id, score: Math.max(35, Math.round(58 + e.comfort * 36 - i * 6)), comfort: e.comfort, reasons: reasons.slice(0, 3) };
    });
    advice.push({ player_id: p.player_id, role, locked_champion_id: null, picks });
  }
  const banPool = ['Zed', 'Darius', 'Jinx', 'Sejuani', 'Leona', 'Veigar', 'Kaisa', 'Thresh'];
  const allUsed = new Set([...used, ...lockedAlly, ...input.ally.map((s) => s.champion_id).filter((c): c is string => !!c)]);
  const bans = banPool.filter((c) => !allUsed.has(c)).slice(0, 3).map((c, i) => ({
    champion_id: c,
    why: [
      `${champName(c)} est très présent en haut elo ce patch (52 % de victoires)`,
      `Contre les champions principaux de Lucas`,
      `Punit le manque de mobilité de votre bot lane`,
    ][i],
  }));
  const enemy = enemyIds.length
    ? {
        identity: 'Composition de pick et de duel : ils veulent attraper un carry isolé puis se battre en 1 contre 1.',
        themes: ['pick', 'early'],
        strengths: ['Très fort en début de partie', 'Engage fiable avec Leona', 'Beaucoup de menace en duel'],
        weaknesses: ['Peu de dégâts magiques : l’armure est rentable', 'Peu de contrôle de zone en combat d’équipe', 'Faible en fin de partie'],
        win_conditions: ['Prendre l’avantage avant 15 minutes', 'Attraper un carry isolé avant les objectifs'],
        threats: enemyIds.slice(0, 3).map((c, i) => ({
          champion_id: c,
          danger: 3 - i,
          why: i === 0 ? `${champName(c)} peut éliminer un carry en un combo.` : `${champName(c)} gagne la plupart de ses duels.`,
          how_to_handle: i === 0 ? 'Acheter un Sablier de Zhonya et rester groupé.' : 'Ne pas l’affronter seul, jouer en surnombre.',
        })),
        damage_profile: { AD: 0.75, AP: 0.25 },
      }
    : null;
  const profiles = input.enemy_profiles ?? [];
  return {
    players: advice,
    bans,
    enemy,
    predictions: mockPredictions(input, allUsed),
    pick_order: mockPickOrder(players, input, advice),
    enemy_players: profiles.map((p) => mockInsight(p, input)),
  };
}

// ---- enemy players (demo) -----------------------------------------------------------------------

interface DemoPlayer {
  puuid: string;
  level: number;
  tier: string;
  division: string;
  role: Role;
  /** [champion, mastery points, recent games, recent wins] */
  pool: [string, number, number, number][];
  style: Partial<PlaystyleStats>;
  timeline?: Partial<TimelineStyle>;
}

const DEMO_PLAYERS: Record<string, DemoPlayer> = {
  'ombredumid#euw': {
    puuid: 'enemy-Zed', level: 412, tier: 'PLATINUM', division: 'II', role: 'MID',
    pool: [['Zed', 612_000, 7, 5], ['Ahri', 48_000, 2, 1], ['Veigar', 21_000, 1, 0]],
    style: { kills: 9.4, deaths: 5.1, assists: 4.2, cs_per_min: 7.8, vision_per_min: 0.5, kill_participation: 0.58, solo_kills: 2.6, first_blood_rate: 0.4, early_lead: 0.6 },
    timeline: { gold_diff_10: 520, cs_10: 86, kills_before_10: 1.33, deaths_before_10: 0.67, first_back_minute: 6.1, wards_per_min: 0.31, level6_minute: 5.83 },
  },
  'hache rouge#1337': {
    puuid: 'enemy-Darius', level: 233, tier: 'GOLD', division: 'I', role: 'TOP',
    pool: [['Darius', 88_000, 4, 2], ['Sett', 64_000, 3, 2], ['MonkeyKing', 30_000, 2, 1], ['Malphite', 12_000, 1, 0]],
    style: { kills: 6.1, deaths: 6.4, assists: 4.0, cs_per_min: 6.9, vision_per_min: 0.45, kill_participation: 0.42, solo_kills: 1.8, first_blood_rate: 0.2, early_lead: 0.4 },
    timeline: { gold_diff_10: -180, cs_10: 71, kills_before_10: 0.67, deaths_before_10: 1.33, first_back_minute: 8.4, wards_per_min: 0.22, level6_minute: 7.1 },
  },
  'aube#sun': {
    puuid: 'enemy-Leona', level: 301, tier: 'GOLD', division: 'II', role: 'SUPPORT',
    pool: [['Leona', 140_500, 5, 3], ['Thresh', 92_000, 3, 2], ['Lulu', 18_000, 2, 1]],
    style: { kills: 1.8, deaths: 5.2, assists: 13.6, cs_per_min: 1.1, vision_per_min: 2.1, kill_participation: 0.66, solo_kills: 0.1, first_blood_rate: 0.3, early_lead: 0.5 },
    timeline: { gold_diff_10: 60, cs_10: 9, kills_before_10: 1.67, deaths_before_10: 0.67, first_back_minute: 5.2, wards_per_min: 1.15, level6_minute: 8.9 },
  },
  'glace#frj': {
    puuid: 'enemy-Sejuani', level: 158, tier: 'SILVER', division: 'I', role: 'JUNGLE',
    pool: [['Sejuani', 23_000, 4, 3], ['Vi', 61_000, 4, 2], ['Amumu', 40_000, 2, 1]],
    style: { kills: 4.9, deaths: 3.8, assists: 9.1, cs_per_min: 5.6, vision_per_min: 1.1, kill_participation: 0.71, solo_kills: 0.6, first_blood_rate: 0.62, early_lead: 0.7 },
    timeline: { gold_diff_10: 310, cs_10: 58, kills_before_10: 2, deaths_before_10: 0.33, first_gank_minute: 3.33, first_gank_lane: 'BOTTOM', first_back_minute: 7.67, wards_per_min: 0.3, level6_minute: 6.4 },
  },
  'gâchette#zau': {
    puuid: 'enemy-Jinx', level: 96, tier: 'GOLD', division: 'III', role: 'BOTTOM',
    pool: [['Jinx', 54_000, 5, 2], ['Caitlyn', 47_000, 3, 2], ['Kaisa', 22_000, 2, 0]],
    style: { kills: 7.2, deaths: 6.8, assists: 6.0, cs_per_min: 6.1, vision_per_min: 0.35, kill_participation: 0.55, solo_kills: 0.4, first_blood_rate: 0.1, early_lead: 0.2 },
    timeline: { gold_diff_10: -240, cs_10: 69, kills_before_10: 0.33, deaths_before_10: 1, first_back_minute: 7.9, wards_per_min: 0.18, level6_minute: 9.2 },
  },
};
const DEMO_BY_PUUID = new Map(Object.entries(DEMO_PLAYERS).map(([id, d]) => [d.puuid, id]));
const DISPLAY_ID: Record<string, string> = {
  'ombredumid#euw': 'OmbreDuMid#EUW', 'hache rouge#1337': 'Hache Rouge#1337', 'aube#sun': 'Aube#SUN', 'glace#frj': 'Glace#FRJ', 'gâchette#zau': 'Gâchette#ZAU',
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A generic player derived from the Riot ID (any name works in the demo). */
function genericPlayer(riotId: string): DemoPlayer {
  const h = hash(riotId.toLowerCase());
  const role = ROLES[h % 5];
  const champs = CHAMPIONS.filter((c) => c.roles.includes(role));
  const pool = [0, 1, 2].map((i) => champs[(h + i * 7) % champs.length]).filter((c, i, a) => a.findIndex((x) => x.id === c.id) === i)
    .map((c, i): [string, number, number, number] => [c.id, 160_000 - i * 55_000 - (h % 20_000), 5 - i, 3 - i]);
  return {
    puuid: `scouted-${h.toString(36)}`, level: 60 + (h % 400), tier: ['SILVER', 'GOLD', 'PLATINUM', 'EMERALD'][h % 4], division: ['I', 'II', 'III', 'IV'][(h >> 3) % 4], role,
    pool,
    style: { kills: 4 + (h % 6), deaths: 3 + ((h >> 4) % 5), assists: 5 + ((h >> 6) % 8), cs_per_min: role === 'SUPPORT' ? 1.2 : 5.5 + ((h >> 2) % 30) / 10, vision_per_min: 0.6 + ((h >> 5) % 12) / 10, kill_participation: 0.45 + ((h >> 7) % 30) / 100, solo_kills: ((h >> 8) % 25) / 10, first_blood_rate: ((h >> 9) % 60) / 100, early_lead: ((h >> 10) % 100) / 100 },
  };
}

function profileOf(riotKey: string | null, d: DemoPlayer, source: EnemyPlayerProfile['source'], games: number, displayId: string | null): EnemyPlayerProfile {
  const recentGames = Math.min(games, d.pool.reduce((n, [, , g]) => n + g, 0));
  return {
    puuid: d.puuid,
    riot_id: displayId ?? (riotKey ? DISPLAY_ID[riotKey] ?? riotKey : null),
    source,
    summoner_level: d.level,
    rank: { queue: 'RANKED_SOLO_5x5', tier: d.tier, division: d.division, lp: 12 + (hash(d.puuid) % 80), wins: 60 + (hash(d.puuid) % 50), losses: 55 + (hash(d.puuid) % 40) },
    masteries: d.pool.map(([c, pts]) => ({ champion_id: c, level: pts > 100_000 ? 7 : 5, points: pts })).sort((a, b) => b.points - a.points),
    recent: {
      games: recentGames,
      roles: { [d.role]: recentGames },
      champions: d.pool.map(([c, , g, w]) => ({ champion_id: c, games: g, wins: w, kills: d.style.kills ?? 5, deaths: d.style.deaths ?? 5, assists: d.style.assists ?? 5, role: d.role, last_played: Date.parse('2026-11-09T20:00:00Z') })),
    },
    style: {
      games: recentGames, wins: Math.min(recentGames, Math.round(d.pool.reduce((n, [, , , w]) => n + w, 0) * recentGames / Math.max(1, d.pool.reduce((n, [, , g]) => n + g, 0)))),
      kills: 5, deaths: 5, assists: 5, cs_per_min: 6, vision_per_min: 0.8, damage_per_min: 640, kill_participation: 0.5,
      solo_kills: 0.5, first_blood_rate: 0.2, early_lead: 0.5, turret_takedowns: 1.2, avg_game_minutes: 29.4,
      ...d.style,
      timeline: demoTimeline(d),
    },
    champion_id: null,
    role: null,
    fetched_at: '2026-11-10T19:55:00.000Z',
  };
}

/** Timeline facts of a demo player (3 games), generic values derived from the puuid. */
function demoTimeline(d: DemoPlayer): TimelineStyle {
  const h = hash(d.puuid);
  const jungle = d.role === 'JUNGLE';
  return {
    games: 3,
    gold_diff_10: ((h % 900) - 400),
    cs_10: d.role === 'SUPPORT' ? 8 : jungle ? 52 + (h % 12) : 62 + (h % 25),
    kills_before_10: Math.round(((h >> 3) % 20) / 10 * 100) / 100,
    deaths_before_10: Math.round(((h >> 5) % 15) / 10 * 100) / 100,
    first_gank_minute: jungle ? 3 + ((h >> 7) % 30) / 10 : null,
    first_gank_lane: jungle ? (['TOP', 'MID', 'BOTTOM'] as Role[])[h % 3] : null,
    first_back_minute: 5 + ((h >> 9) % 40) / 10,
    wards_per_min: d.role === 'SUPPORT' ? 1.1 : Math.round((0.15 + ((h >> 11) % 30) / 100) * 100) / 100,
    level6_minute: 5.5 + ((h >> 13) % 40) / 10,
    ...d.timeline,
  };
}

function demoProfile(riotId: string, source: EnemyPlayerProfile['source']): EnemyPlayerProfile {
  const key = riotId.toLowerCase();
  return profileOf(key, DEMO_PLAYERS[key] ?? genericPlayer(riotId), source, source === 'scouting' ? 10 : 5, null);
}

// Demo draft: two opponents scouted by Riot ID before the draft (Clash).
drafts.get('team-t1')!.enemy_profiles = [demoProfile('OmbreDuMid#EUW', 'scouting'), demoProfile('Glace#FRJ', 'scouting')];

/** Simulates the Riot calls (progress ticks) of a profile build. */
export async function mockEnemyProfile(req: ProfileRequest, onProgress?: (p: ProfileProgress) => void): Promise<EnemyPlayerProfile> {
  const count = req.match_count ?? (req.source === 'scouting' ? 10 : 5);
  const total = (req.puuid ? 0 : 1) + 4 + count + Math.min(3, count);
  for (let calls = 0; calls <= total; calls++) {
    onProgress?.({ calls, total });
    if (calls < total) await delay(110 + Math.random() * 90);
    if (calls === 0 && !req.puuid && /^ghost#/i.test(req.riot_id ?? '')) throw new ApiError(`Riot ID introuvable : ${req.riot_id}. Vérifiez l'orthographe et le tag.`, 404);
  }
  const key = req.puuid ? DEMO_BY_PUUID.get(req.puuid) ?? null : (req.riot_id ?? '').toLowerCase();
  const demo = key ? DEMO_PLAYERS[key] : undefined;
  // Client-revealed players: no Riot ID (the client only gives the puuid).
  const display = req.source === 'client' ? null : req.riot_id ?? null;
  const p = demo ? profileOf(key, demo, req.source, count, display ?? DISPLAY_ID[key ?? ''] ?? null) : profileOf(null, genericPlayer(req.riot_id ?? req.puuid ?? 'x'), req.source, count, display);
  if (req.source === 'client') p.riot_id = null;
  if (req.puuid) p.puuid = req.puuid;
  const clash = req.clash_team !== undefined ? { clash_team: req.clash_team, clash_position: req.clash_team ? req.clash_position ?? null : null } : {};
  return { ...p, ...clash, champion_id: req.champion_id ?? null, role: req.role ?? null, fetched_at: new Date().toISOString() };
}

// ---- Clash + key limits (demo) -------------------------------------------------------------------

/** Raw clash-v1 payloads: the scouted opponents' team (one member without puuid) and ours. */
const MOCK_CLASH_TEAMS: Record<string, unknown> = {
  'team-ombres': {
    id: 'team-ombres', tournamentId: 4201, name: 'Les Ombres', iconId: 12, tier: 2, captain: 'x', abbreviation: 'OMB',
    players: [
      { summonerId: 's1', puuid: 'enemy-Zed', position: 'MIDDLE', role: 'CAPTAIN' },
      { summonerId: 's2', puuid: 'enemy-Darius', position: 'TOP', role: 'MEMBER' },
      { summonerId: 's3', puuid: 'enemy-Leona', position: 'UTILITY', role: 'MEMBER' },
      { summonerId: 's4', puuid: 'enemy-Sejuani', position: 'JUNGLE', role: 'MEMBER' },
      { summonerId: 's5', position: 'BOTTOM', role: 'MEMBER' },
    ],
  },
  'team-jeudi': {
    id: 'team-jeudi', tournamentId: 4201, name: 'Les Potes du Jeudi', iconId: 7, tier: 3, captain: 'y', abbreviation: 'JEU',
    players: [
      { summonerId: 'f1', puuid: 'puuid-1', position: 'MIDDLE', role: 'CAPTAIN' },
      { summonerId: 'f2', puuid: 'puuid-2', position: 'TOP', role: 'MEMBER' },
      { summonerId: 'f3', puuid: 'puuid-friend-3', position: 'JUNGLE', role: 'MEMBER' },
      { summonerId: 'f4', puuid: 'puuid-friend-4', position: 'BOTTOM', role: 'MEMBER' },
      { summonerId: 'f5', puuid: 'puuid-friend-5', position: 'FILL', role: 'MEMBER' },
    ],
  },
};
const MOCK_CLASH_PLAYERS: Record<string, string> = {
  'enemy-Zed': 'team-ombres', 'enemy-Darius': 'team-ombres', 'enemy-Leona': 'team-ombres', 'enemy-Sejuani': 'team-ombres',
  'puuid-1': 'team-jeudi', 'puuid-2': 'team-jeudi',
};

function mockTournaments(now: number): unknown[] {
  const day = 24 * 3600 * 1000;
  const at18 = (offsetDays: number) => {
    const d = new Date(now + offsetDays * day);
    d.setHours(18, 0, 0, 0);
    return d.getTime();
  };
  return [
    { id: 4201, themeId: 3, nameKey: 'bilgewater', nameKeySecondary: 'day_1', schedule: [{ id: 1, registrationTime: now - 3 * day, startTime: at18(1), cancelled: false }] },
    { id: 4202, themeId: 3, nameKey: 'bilgewater', nameKeySecondary: 'day_2', schedule: [{ id: 2, registrationTime: now - 3 * day, startTime: at18(2), cancelled: false }] },
    { id: 4310, themeId: 5, nameKey: 'ionia', nameKeySecondary: 'day_1', schedule: [{ id: 3, registrationTime: at18(10), startTime: at18(15), cancelled: false }] },
  ];
}

/** Same payloads as the PHP proxy routes (riot/clash-*), with a little latency. */
export const mockClashFetcher: ClashFetcher = {
  async player(puuid) {
    await delay(150);
    const team = MOCK_CLASH_PLAYERS[puuid];
    if (!team) return [];
    const raw = MOCK_CLASH_TEAMS[team] as { players: { puuid?: string; position: string; role: string }[] };
    const me = raw.players.find((p) => p.puuid === puuid);
    return [{ summonerId: 'x', puuid, teamId: team, position: me?.position ?? 'FILL', role: me?.role ?? 'MEMBER' }];
  },
  async team(teamId) {
    await delay(180);
    const raw = MOCK_CLASH_TEAMS[teamId];
    if (!raw) throw new ApiError('Introuvable chez Riot.', 404);
    return clone(raw);
  },
  async tournaments() {
    await delay(150);
    return mockTournaments(Date.now());
  },
};

export async function mockRiotLimits(): Promise<RiotKeyLimits> {
  await delay(150);
  const at = new Date(Date.now() - 40_000).toISOString();
  return {
    app: [
      { limit: 20, window: 1, count: 2, at },
      { limit: 100, window: 120, count: 41, at },
    ],
    collector_share: 0.6,
    user_share: 0.95,
  };
}

const TIER_ORDER = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
const ROLE_FR: Record<Role, string> = { TOP: 'top', JUNGLE: 'jungler', MID: 'mid', BOTTOM: 'ADC', SUPPORT: 'support' };

function mainRole(p: EnemyPlayerProfile): Role | null {
  let best: Role | null = null;
  let n = 0;
  for (const r of ROLES) if ((p.recent.roles[r] ?? 0) > n) { best = r; n = p.recent.roles[r] ?? 0; }
  return best;
}

/** Locked enemy champion clearly in this scouted player's pool (and in no other one). */
function inferredChampion(p: EnemyPlayerProfile, input?: DraftInput): string | null {
  if (p.champion_id || !input) return p.champion_id ?? null;
  const locked = input.enemy.filter((s) => s.champion_id && !s.puuid).map((s) => s.champion_id as string);
  const pool = (x: EnemyPlayerProfile) => new Set([...x.masteries.slice(0, 5).map((m) => m.champion_id), ...x.recent.champions.map((c) => c.champion_id)]);
  const others = (input.enemy_profiles ?? []).filter((x) => x.puuid !== p.puuid && !x.champion_id);
  const hits = locked.filter((c) => pool(p).has(c) && !others.some((o) => pool(o).has(c)));
  return hits.length === 1 ? hits[0] : null;
}

const clock = (m: number) => `${Math.floor(m)}:${String(Math.round((m % 1) * 60)).padStart(2, '0')}`;

function mockInsight(p: EnemyPlayerProfile, input?: DraftInput): EnemyPlayerInsight {
  const s = p.style;
  const champion = inferredChampion(p, input);
  const role = p.role ?? mainRole(p) ?? (p.clash_position ? ({ TOP: 'TOP', JUNGLE: 'JUNGLE', MIDDLE: 'MID', BOTTOM: 'BOTTOM', UTILITY: 'SUPPORT' } as Record<string, Role>)[p.clash_position] ?? null : null);
  const tags: string[] = [];
  const threats: string[] = [];
  const attention: string[] = [];
  if (s) {
    if (s.kills + s.deaths >= 13) tags.push('Très agressif');
    if (s.first_blood_rate >= 0.45) tags.push('Cherche le premier sang');
    if (s.solo_kills >= 2) tags.push('Gros duelliste');
    if (s.cs_per_min >= 7.5) tags.push('Farm avant tout');
    if (s.vision_per_min < 0.6 && role !== 'SUPPORT') tags.push('Vision faible');
    if (s.vision_per_min >= 1.8) tags.push('Contrôle de la vision');
    if (s.kill_participation >= 0.65) tags.push('Toujours dans les combats');
    if ((s.early_lead ?? 0) >= 0.6) tags.push('Gagne souvent sa lane');
    if (s.deaths >= 6.5) tags.push('Meurt souvent');
  }
  const top = p.masteries[0];
  const recentTop = p.recent.champions[0];
  if (top && top.points >= 200_000) threats.push(`One-trick ${champName(top.champion_id)} (${Math.round(top.points / 1000)}k points)`);
  else if (recentTop && p.recent.games && recentTop.games / p.recent.games >= 0.4) threats.push(`Joue surtout ${champName(recentTop.champion_id)} (${recentTop.games} parties récentes sur ${p.recent.games})`);
  if (p.rank && TIER_ORDER.indexOf(p.rank.tier) >= TIER_ORDER.indexOf('PLATINUM')) threats.push('Le mieux classé de leur équipe');
  if (s && s.games >= 5 && s.wins / s.games >= 0.65) threats.push(`En forme : ${s.wins} victoires sur ${s.games} parties`);
  if (role === 'JUNGLE' && s && s.first_blood_rate >= 0.45) attention.push('Envahit tôt : wardez votre jungle à 2:30 et jouez groupés au niveau 2-3.');
  if (role === 'MID' && s && s.solo_kills >= 2) attention.push('Respectez son niveau 6 : pas d’échange sans votre jungler à proximité.');
  if (s && s.vision_per_min < 0.6 && role !== 'SUPPORT') attention.push('Peu de vision : punissez-le avec des gank par la rivière.');
  if (s && s.deaths >= 6.5) attention.push('Prend des risques : un gank tôt peut le faire craquer.');
  const tl = s?.timeline;
  if (tl) {
    if (role === 'JUNGLE' && tl.first_gank_minute !== null && tl.first_gank_minute < 4) {
      tags.push('Jungler qui gank tôt');
      const lane = tl.first_gank_lane ? ({ TOP: 'top', MID: 'mid', BOTTOM: 'bot' } as Partial<Record<Role, string>>)[tl.first_gank_lane] : null;
      attention.unshift(`Premier gank vers ${clock(tl.first_gank_minute)}${lane ? `, surtout ${lane}` : ''} : wardez la rivière avant.`);
    }
    if ((tl.gold_diff_10 ?? 0) >= 400) tags.push('Prend l’avance en lane');
    if (role !== 'SUPPORT' && tl.wards_per_min < 0.25) tags.push('Pose peu de balises');
    if ((tl.first_back_minute ?? 0) >= 7.5) attention.push(`Retour en base tardif (${clock(tl.first_back_minute as number)}) : punissable par un recall synchronisé.`);
  }
  if (p.clash_position && p.clash_team) {
    const pos: Record<string, string> = { TOP: 'top', JUNGLE: 'jungle', MIDDLE: 'mid', BOTTOM: 'ADC', UTILITY: 'support', FILL: 'remplaçant' };
    if (pos[p.clash_position]) threats.push(`Poste Clash déclaré : ${pos[p.clash_position]} (${p.clash_team.name})`);
  }
  if (!attention.length) attention.push('Joueur régulier : jouez votre plan sans prendre de risque inutile.');
  return {
    puuid: p.puuid,
    riot_id: p.riot_id ?? null,
    role,
    champion_id: champion,
    level: p.summoner_level ?? null,
    rank: p.rank ?? null,
    style_tags: tags.slice(0, 4),
    threats,
    attention_points: attention.slice(0, 3),
    likely_picks: champion ? [] : [...new Set([...p.recent.champions.map((c) => c.champion_id), ...p.masteries.map((m) => m.champion_id)])].slice(0, 3),
  };
}

function mockAttention(profiles: EnemyPlayerProfile[]): PhaseAttention[] {
  const out: PhaseAttention[] = [];
  const who = (p: EnemyPlayerProfile) => `${ROLE_FR[p.role ?? mainRole(p) ?? 'MID']}${p.champion_id ? ` (${champName(p.champion_id)})` : ''}`;
  for (const p of profiles) {
    const s = p.style;
    const role = p.role ?? mainRole(p);
    if (!s) continue;
    if (role === 'JUNGLE' && s.first_blood_rate >= 0.45) out.push({ phase: 'early', enemy_puuid: p.puuid, text: `Early : leur ${who(p)} cherche le premier sang dans ${Math.round(s.first_blood_rate * 100)} % de ses parties : wardez votre jungle à 2:30.` });
    if (s.solo_kills >= 2) out.push({ phase: 'early', enemy_puuid: p.puuid, text: `Early : leur ${who(p)} fait ${s.solo_kills.toLocaleString('fr-FR')} solo kills par partie : pas de duel à 1 contre 1 avant vos objets clés.` });
    if (s.vision_per_min < 0.6 && role !== 'SUPPORT') out.push({ phase: 'mid', enemy_puuid: p.puuid, text: `Mid : leur ${who(p)} place peu de balises : tendez des embuscades sur son côté de la carte.` });
    if (s.cs_per_min >= 7.5) out.push({ phase: 'mid', enemy_puuid: p.puuid, text: `Mid : leur ${who(p)} farme beaucoup (${s.cs_per_min.toLocaleString('fr-FR')} CS/min) : forcez les combats avant qu’il complète ses objets.` });
    if (s.kill_participation >= 0.65) out.push({ phase: 'late', enemy_puuid: p.puuid, text: `Late : leur ${who(p)} suit toutes les rotations : comptez-le présent à chaque objectif.` });
    if (s.deaths >= 6.5) out.push({ phase: 'late', enemy_puuid: p.puuid, text: `Late : leur ${who(p)} se fait souvent attraper : gardez vos contrôles pour lui avant le Nashor.` });
  }
  if (!out.some((a) => a.phase === 'late')) out.push({ phase: 'late', text: 'Late : restez groupés autour du Nashor, leur compo gagne les escarmouches mais pas les longs combats.' });
  return out;
}

function mockPredictions(input: DraftInput, used: Set<string>): EnemyRolePrediction[] {
  const taken = new Set<Role>();
  for (const s of input.enemy) {
    if (!s.champion_id) continue;
    const r = s.role ?? champById(s.champion_id)?.roles.find((x) => !taken.has(x));
    if (r) taken.add(r);
  }
  const lockedAlly = input.ally.filter((s) => s.locked && s.champion_id).map((s) => s.champion_id as string);
  const profiles = (input.enemy_profiles ?? []).filter((p) => !p.champion_id && !inferredChampion(p, input));
  return ROLES.filter((r) => !taken.has(r)).map((role) => {
    const player = profiles.find((p) => mainRole(p) === role);
    const fromPlayer = player
      ? player.recent.champions.filter((c) => !used.has(c.champion_id)).slice(0, 3).map((c, i) => ({
          champion_id: c.champion_id, likelihood: 0.5 - i * 0.12, player_puuid: player.puuid,
          why: `Champion de confort de ${player.riot_id ?? 'ce joueur'} (${c.games} parties récentes)`,
        }))
      : [];
    const meta = CHAMPIONS.filter((c) => c.roles.includes(role) && !used.has(c.id) && !fromPlayer.some((x) => x.champion_id === c.id))
      .slice(0, 5 - fromPlayer.length)
      .map((c, i) => ({
        champion_id: c.id,
        likelihood: (fromPlayer.length ? 0.14 : 0.36) - i * 0.06,
        why: lockedAlly.includes('Malphite') && c.traits.mobility >= 2 ? `Bon contre votre Malphite (${51 + i} % de victoires)` : `Très joué en ${ROLE_FR[role]} en haut elo (${14 - i * 2} % des parties)`,
      }));
    const cands = [...fromPlayer, ...meta].filter((c) => c.likelihood > 0);
    const sum = cands.reduce((n, c) => n + c.likelihood, 0) || 1;
    return { role, candidates: cands.map((c) => ({ ...c, likelihood: Math.round((c.likelihood / sum) * 100) / 100 })) };
  });
}

function mockPickOrder(players: PlayerInput[], input: DraftInput, advice: PlayerPickAdvice[]): string[] {
  const open = advice.filter((a) => !a.locked_champion_id && a.role);
  if (!open.length) return [];
  const known = new Set<Role>();
  for (const s of input.enemy) {
    const r = s.champion_id ? s.role ?? champById(s.champion_id)?.roles[0] : null;
    if (r) known.add(r);
  }
  const name = (id: string) => players.find((p) => p.player_id === id)?.name ?? 'Un ami';
  const out: string[] = [];
  for (const a of open) {
    const r = a.role as Role;
    if (known.has(r)) out.push(`${name(a.player_id)} (${ROLE_FR[r]}) peut picker maintenant : leur ${ROLE_FR[r]} est connu, c’est le moment du counter-pick.`);
    else out.push(`${name(a.player_id)} (${ROLE_FR[r]}) devrait picker en dernier : leur ${ROLE_FR[r]} n’est pas encore connu, gardez le counter-pick.`);
  }
  if (input.side === 'blue') out.push('Côté bleu : vos picks 4 et 5 répondent à leurs derniers choix, placez-y les rôles les plus sensibles aux counters (mid, top).');
  else if (input.side === 'red') out.push('Côté rouge : vous avez le dernier pick, gardez-le pour le rôle le plus exposé aux counters.');
  return out.slice(0, 4);
}

function notFound(what: string): never {
  throw new ApiError(`${what} introuvable.`, 404);
}

export async function mockRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  await delay(250 + Math.random() * 250);
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const [a, b, c] = parts;
  const route = `${method} /${parts.map((p, i) => (i === 1 && !['generate', 'game-plan', 'matchup', 'saved'].includes(p) ? ':id' : i === 2 && a === 'compositions' ? ':id' : p)).join('/')}`;

  switch (route) {
    case 'GET /health': return { status: 'ok' };
    case 'GET /meta': return { ...META, meta_stats: { patch: MOCK_PATCH, ...mockPatches[MOCK_PATCH] } };
    case 'GET /champions': return clone(CHAMPIONS);
    case 'GET /archetypes': return clone(ARCHETYPES);
    case 'GET /themes': return clone(THEMES);

    case 'GET /players': return clone(players);
    case 'POST /players': {
      const { game_name, tag_line, platform } = body as { game_name: string; tag_line: string; platform?: string };
      if (!game_name?.trim() || !tag_line?.trim()) throw new ApiError('Riot ID invalide.', 422);
      if (players.some((p) => p.game_name.toLowerCase() === game_name.toLowerCase() && p.tag_line.toLowerCase() === tag_line.toLowerCase())) {
        throw new ApiError(`${game_name}#${tag_line} est déjà dans la liste.`, 409);
      }
      const p: Player = {
        id: uid('p'), game_name, tag_line, platform: platform ?? META.platform, puuid: null,
        profile_icon_url: '', summoner_level: null, rank: null, last_synced_at: null,
        preferences: prefs({}), masteries: [], recent: { games: 0, roles: {}, champions: [] }, manual_pool: [], pool: [],
      };
      players.push(p);
      return clone(p);
    }
    case 'GET /players/:id': return clone(players.find((p) => p.id === b) ?? notFound('Joueur'));
    case 'DELETE /players/:id':
      players = players.filter((p) => p.id !== b);
      teams = teams.map((t) => ({ ...t, player_ids: t.player_ids.filter((id) => id !== b) }));
      return undefined;
    case 'POST /players/:id/sync': {
      const p = players.find((x) => x.id === b) ?? notFound('Joueur');
      if (!p.puuid) throw new ApiError('Clé API Riot non configurée : synchronisation impossible pour un joueur manuel.', 400);
      p.last_synced_at = new Date().toISOString();
      return clone(p);
    }
    case 'PUT /players/:id/preferences': {
      const p = players.find((x) => x.id === b) ?? notFound('Joueur');
      p.preferences = clone(body as PlayerPreferences);
      recomputePool(p);
      return clone(p);
    }
    case 'PUT /players/:id/pool': {
      const p = players.find((x) => x.id === b) ?? notFound('Joueur');
      p.manual_pool = clone((body as { champions: Player['manual_pool'] }).champions);
      recomputePool(p);
      return clone(p);
    }

    case 'GET /teams': return clone(teams);
    case 'POST /teams': {
      const tb = body as { name: string; player_ids: string[] };
      if (tb.player_ids.length > 5) throw new ApiError('Une équipe compte au maximum 5 joueurs.', 422);
      const t: Team = { id: uid('t'), name: tb.name, player_ids: tb.player_ids, created_at: new Date().toISOString() };
      teams.push(t);
      return clone(t);
    }
    case 'GET /teams/:id': return clone(teams.find((t) => t.id === b) ?? notFound('Équipe'));
    case 'PUT /teams/:id': {
      const t = teams.find((x) => x.id === b) ?? notFound('Équipe');
      Object.assign(t, body as object);
      return clone(t);
    }
    case 'DELETE /teams/:id':
      teams = teams.filter((t) => t.id !== b);
      return undefined;

    case 'POST /compositions/generate': return generate(body as GenerateBody);
    case 'POST /compositions/game-plan': return gamePlan((body as { picks: Pick[] }).picks);
    case 'POST /compositions/matchup': return matchup(body as MatchupBody);
    case 'GET /compositions/saved': return clone(saved);
    case 'POST /compositions/saved': {
      const s: SavedComposition = { ...(body as Omit<SavedComposition, 'id' | 'created_at'>), id: uid('s'), created_at: new Date().toISOString() };
      saved.unshift(s);
      return clone(s);
    }
    case 'DELETE /compositions/saved/:id':
      saved = saved.filter((s) => s.id !== c);
      return undefined;

    case 'GET /drafts/:id': return drafts.has(b) ? clone(drafts.get(b)!) : null;
    case 'PUT /drafts/:id': {
      const doc = { ...clone(body as DraftState), id: b };
      drafts.set(b, doc);
      return clone(doc);
    }
    case 'POST /live-draft': return mockLive((body as { players: string[] }).players);
    case 'POST /draft/:id': {
      if (b !== 'detect') break;
      return mockDetect((body as { friends: { player_id: string }[] }).friends);
    }
  }
  throw new ApiError(`Route mock inconnue : ${method} ${path}`, 404);
}

// ---- high-elo meta (Meta page) ---------------------------------------------------------------

const MOCK_PATCH = '16.19';
const MOCK_TARGET = 500;
/** Kept games per tier on the current patch (ring buffers of MOCK_TARGET); the old patch is full. */
const mockTierGames: Record<MetaTier, number> = {
  IRON: 46, BRONZE: 188, SILVER: 342, GOLD: 500, PLATINUM: 500, EMERALD: 417, DIAMOND: 263, MASTER_PLUS: 500,
};
const mockTierNewest: Partial<Record<MetaTier, string>> = {};
const tierGames = (patch: string, tier: MetaTier) => (patch === MOCK_PATCH ? mockTierGames[tier] : MOCK_TARGET);
const mockPatches: Record<string, { games: number; updated_at: string }> = {
  [MOCK_PATCH]: { games: 0, updated_at: '2026-10-10T12:00:00Z' },
  '16.18': { games: MOCK_TARGET * META_TIERS.length, updated_at: '2026-09-26T23:00:00Z' },
};
const syncPatchTotal = () => {
  mockPatches[MOCK_PATCH].games = META_TIERS.reduce((n, t) => n + mockTierGames[t], 0);
};
syncPatchTotal();
let mockPass = 0;
let mockLastRun: MetaStatus['last_run'] = {
  stop: 'budget de temps atteint', requests: 412, new_matches: 38, patch: MOCK_PATCH, games: 500, duration_s: 1500, at: '2026-10-10T12:00:00Z', source: 'cron',
};

const mockTierList = (): MetaTierProgress[] => META_TIERS.map((tier, i) => ({
  tier,
  patch: MOCK_PATCH,
  games: mockTierGames[tier],
  target: MOCK_TARGET,
  oldest: new Date(Date.UTC(2026, 9, 8, 6 + i)).toISOString(),
  newest: mockTierNewest[tier] ?? new Date(Date.UTC(2026, 9, 10, 11, 5 * i)).toISOString(),
}));

/** Deterministic 0..1 noise from a string. */
function noise(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

const patchList = () =>
  Object.entries(mockPatches)
    .map(([patch, v]) => ({ patch, ...v }))
    .sort((a, b) => b.patch.localeCompare(a.patch, 'en', { numeric: true }));

export async function mockMetaStatus(): Promise<MetaStatus> {
  await delay(200);
  const h = new Date().getHours();
  return {
    collecting: false, admin_enabled: true, meta_enabled: true, last_run: clone(mockLastRun), patches: patchList(),
    tiers: mockTierList(), window: { start: 4, end: 15, open: h >= 4 && h < 15 },
  };
}

/** Fake aggregates scaled on the tier's games (a few rare picks keep the small-sample UI visible). */
export async function mockMetaStats(patch?: string | null, tier?: MetaTier | null): Promise<MetaStats | null> {
  await delay(250);
  const p = patch || MOCK_PATCH;
  const t: MetaTier = tier ?? 'MASTER_PLUS';
  const info = mockPatches[p];
  if (!info) return null;
  const G = tierGames(p, t);
  if (!G) return null;
  const seed = `${p}:${t}`;
  const champions: MetaStats['champions'] = {};
  const bans: MetaStats['bans'] = {};
  const byRole: Partial<Record<Role, string[]>> = {};
  for (const c of CHAMPIONS) {
    const roles: Partial<Record<Role, GamesWins>> = {};
    c.roles.forEach((role, i) => {
      const n = noise(`${seed}:${c.id}:${role}`);
      const share = i === 0 ? 0.04 + n * 0.22 : n < 0.5 ? 0.003 + n * 0.012 : 0.01 + n * 0.05;
      const games = Math.max(1, Math.round(G * share));
      const wr = 0.45 + noise(`${seed}:${c.id}:${role}:wr`) * 0.1;
      roles[role] = [games, Math.round(games * wr)];
      (byRole[role] ??= []).push(c.id);
    });
    champions[c.id] = roles;
    const b = noise(`${seed}:${c.id}:ban`);
    if (b > 0.25) bans[c.id] = Math.round(G * (b - 0.25) * 0.35);
  }
  const matchups: MetaStats['matchups'] = {};
  for (const role of ROLES) {
    const ids = byRole[role] ?? [];
    const out: Record<string, Record<string, GamesWins>> = {};
    for (const a of ids) {
      for (const b of ids) {
        if (a >= b) continue;
        const ga = champions[a]?.[role]?.[0] ?? 0;
        const gb = champions[b]?.[role]?.[0] ?? 0;
        const games = Math.round(Math.min(ga, gb) * (0.08 + noise(`${seed}:${role}:${a}:${b}`) * 0.25));
        if (games < 1) continue;
        const wins = Math.round(games * (0.38 + noise(`${seed}:${role}:${b}:${a}`) * 0.24));
        (out[a] ??= {})[b] = [games, wins];
        (out[b] ??= {})[a] = [games, games - wins];
      }
    }
    matchups[role] = out;
  }
  return { patch: p, platform: META.platform, tier: t, games: G, updated_at: mockTierNewest[t] ?? info.updated_at, champions, bans, matchups };
}

/**
 * Simulated pass (~2 s), round-robin on the least filled tier: budget passes, a Riot pause
 * (riot_limit, 6 s) on the 2nd pass of each cycle, then two "tour complet". "faux" = wrong password.
 */
export async function mockCollectMeta(password: string): Promise<CollectResult> {
  await delay(1800 + Math.random() * 600);
  if (password.trim().toLowerCase() === 'faux') throw new ApiError('Mot de passe administrateur incorrect.', 401);
  mockPass++;
  const step = mockPass % 6;
  const complete = step === 5 || step === 0;
  const limited = step === 2;
  const tier = META_TIERS.reduce((best, t) => (mockTierGames[t] < mockTierGames[best] ? t : best), META_TIERS[0]);
  const fresh = limited ? 4 : complete ? Math.round(Math.random() * 6) : 25 + Math.round(Math.random() * 30);
  const now = new Date().toISOString();
  mockTierGames[tier] = Math.min(MOCK_TARGET, mockTierGames[tier] + fresh);
  mockTierNewest[tier] = now;
  syncPatchTotal();
  mockPatches[MOCK_PATCH].updated_at = now;
  const run = {
    stop: limited ? 'riot_limit' : complete ? 'tour complet' : 'budget',
    requests: limited ? 9 : complete ? 20 + Math.round(Math.random() * 15) : 11,
    new_matches: fresh,
    patch: MOCK_PATCH,
    games: mockTierGames[tier],
    duration_s: limited ? 8.2 : complete ? 12.4 : 45,
    at: now,
    source: 'web' as const,
    tier,
    ...(limited ? { retry_after: 6 } : {}),
  };
  mockLastRun = run;
  return { status: 'ok', ...run, patches: patchList() };
}
