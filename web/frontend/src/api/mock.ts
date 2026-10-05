// Dev-only in-memory backend, enabled with VITE_MOCK=1. Never bundled in production builds
// (client.ts imports it dynamically behind a compile-time constant).
import { ApiError } from './client';
import type {
  ArchetypeInfo,
  ChampionInfo,
  ChampionTraits,
  CompositionSuggestion,
  DamageType,
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
} from './types';
import { ROLES } from './types';

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
    profile_icon_url: '', summoner_level: 342, rank: null, last_synced_at: '2026-10-01T09:00:00Z',
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
  };
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
    case 'GET /meta': return META;
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
  }
  throw new ApiError(`Route mock inconnue : ${method} ${path}`, 404);
}
