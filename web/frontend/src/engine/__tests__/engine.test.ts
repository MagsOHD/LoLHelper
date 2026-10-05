// Ported from the former Python engine tests (catalog, pool, generator, plans, data, smoke, text).
import { describe, expect, it } from 'vitest';
import type { CompositionSuggestion, GenerationOptions, Pick, PlayerInput, Role } from '../../api/types';
import {
  asCatalog,
  buildCatalog,
  buildGamePlan,
  buildMatchupPlan,
  computePool,
  elide,
  generateCompositions,
  getTheme,
  listArchetypes,
  listThemes,
  type Catalog,
  type ChampionCatalog,
  type DDragonChampion,
} from '../index';
import championsMeta from '../data/champions_meta.json';
import archetypesData from '../data/archetypes.json';
import { pyFixed, pyRound } from '../pycompat';
import { baseMeta, bigCatalog, fivePlayers, player, smallCatalog } from './fixtures';

const ROLES: Role[] = ['TOP', 'JUNGLE', 'MID', 'BOTTOM', 'SUPPORT'];
const NO_PREFS = { roles: [], wanted_archetypes: [], wanted_champions: [], avoided_champions: [] };

// ----------------------------------------------------------------------------- python compat

describe('python compat', () => {
  it('rounds half to even on the exact binary value like Python round()', () => {
    expect(pyRound(2.5)).toBe(2);
    expect(pyRound(3.5)).toBe(4);
    expect(pyRound(0.5)).toBe(0);
    expect(pyRound(-2.5)).toBe(-2);
    expect(pyRound(0.125, 2)).toBe(0.12);
    expect(pyRound(0.375, 2)).toBe(0.38);
    expect(pyRound(2.675, 2)).toBe(2.67); // 2.67499999... in binary
    expect(pyRound(1.005, 2)).toBe(1); // 1.00499999...
    expect(pyRound(0.0625, 3)).toBe(0.062);
    expect(pyRound(91.25, 1)).toBe(91.2);
    expect(pyRound(91.35, 1)).toBe(91.3); // 91.3499999...
    expect(pyRound(0.123456789, 4)).toBe(0.1235);
  });

  it('formats like f"{x:.1f}"', () => {
    expect(pyFixed(2.25, 1)).toBe('2.2');
    expect(pyFixed(2.35, 1)).toBe('2.4'); // 2.35000000000000008...
    expect(pyFixed(1.0, 1)).toBe('1.0');
    expect(pyFixed(1.05, 1)).toBe('1.1'); // 1.0500000000000000444...
  });
});

// ----------------------------------------------------------------------------- text

describe('text', () => {
  it('elides before vowel names', () => {
    expect(elide("l'engage de Amumu")).toBe("l'engage d'Amumu");
    expect(elide('avant que Ahri ait ses objets')).toBe("avant qu'Ahri ait ses objets");
    expect(elide('la Orianna')).toBe("l'Orianna");
  });

  it('keeps consonants and lowercase words', () => {
    expect(elide('les dégâts de Jinx')).toBe('les dégâts de Jinx');
    expect(elide('de une à deux')).toBe('de une à deux');
    expect(elide('Rôle Akali')).toBe('Rôle Akali'); // Unicode word boundary, like Python \b
  });
});

// ----------------------------------------------------------------------------- catalog

const DDRAGON: DDragonChampion[] = [
  {
    id: 'Malphite',
    key: '54',
    name: 'Malphite',
    title: 'le fragment du Monolithe',
    tags: ['Tank', 'Fighter'],
    info: { attack: 5, defense: 9, magic: 7, difficulty: 2 },
    image: { full: 'Malphite.png' },
  },
  {
    id: 'Newchamp',
    key: '999',
    name: 'Nouveau',
    title: 'le nouveau',
    tags: ['Marksman'],
    info: { attack: 8, defense: 3, magic: 2, difficulty: 6 },
    image: { full: 'Newchamp.png' },
  },
  {
    id: 'Newmage',
    key: '998',
    name: 'Mage Neuf',
    title: '',
    tags: ['Mage', 'Support'],
    info: { attack: 2, defense: 3, magic: 9, difficulty: 5 },
    image: { full: 'Newmage.png' },
  },
];

describe('catalog', () => {
  it('merges Data Dragon and meta', () => {
    const cat = buildCatalog(DDRAGON, '14.1.1', baseMeta());
    expect(cat.size).toBe(3);
    const malph = cat.get('Malphite')!;
    expect(malph.key).toBe(54);
    expect(malph.title).toBe('le fragment du Monolithe');
    expect(malph.image_url).toBe('https://ddragon.leagueoflegends.com/cdn/14.1.1/img/champion/Malphite.png');
    expect(malph.archetype).toBe('vanguard');
    expect(malph.region).toBe('ixtal');
    expect(malph.traits.engage).toBe(3);
    expect(cat.byKey(54)!.id).toBe('Malphite');
    expect(cat.meta('Malphite').playstyle.startsWith('Style de jeu')).toBe(true);
  });

  it('falls back for champions unknown to the curated data', () => {
    const cat = buildCatalog(DDRAGON, '14.1.1', baseMeta());
    const n = cat.get('Newchamp')!;
    expect(n.archetype).toBe('marksman');
    expect(n.roles).toEqual(['BOTTOM']);
    expect(n.damage_type).toBe('AD');
    expect(n.traits.late).toBe(3);
    const mage = cat.get('Newmage')!;
    expect(mage.archetype).toBe('enchanter');
    expect(mage.damage_type).toBe('AP');
    expect(cat.meta('Newchamp')).toEqual({ power_spikes: [], playstyle: '', counter_tips: '' });
  });

  it('uses curated data only offline', () => {
    const cat = smallCatalog();
    expect(cat.size).toBe(Object.keys(baseMeta()).length);
    expect(cat.get('LeeSin')!.name).toBe('Lee Sin');
    expect(cat.get('leesin')!.id).toBe('LeeSin');
    expect(cat.get('lee sin')!.id).toBe('LeeSin');
    expect(cat.get('LeeSin')!.image_url).toBe('');
    expect(cat.get('Nope')).toBeUndefined();
    const names = cat.all().map((c) => c.name);
    expect(names).toEqual([...names].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)));
  });

  it('lists archetypes and themes', () => {
    const keys = new Set(listArchetypes().map((a) => a.key));
    for (const k of ['vanguard', 'marksman', 'enchanter']) expect(keys.has(k)).toBe(true);
    const themes = new Map(listThemes().map((t) => [t.key, t]));
    for (const k of [
      'engage', 'pick', 'poke_siege', 'protect_carry', 'split_push', 'dive', 'early_snowball', 'scaling',
      'skirmish', 'yordles', 'void', 'shadow_isles', 'noxus', 'demacia', 'freljord', 'ionia', 'piltover_zaun',
      'shurima', 'full_ap', 'full_ad', 'lore',
    ]) {
      expect(themes.has(k)).toBe(true);
    }
    expect(themes.get('engage')!.kind).toBe('playstyle');
    expect(themes.get('yordles')!.kind).toBe('thematic');
  });

  it('adapts a foreign object implementing the ChampionCatalog contract', () => {
    const real = smallCatalog();
    const foreign: ChampionCatalog = { get: (id) => real.get(id), byKey: (k) => real.byKey(k), all: () => real.all() };
    const adapted = asCatalog(foreign);
    expect(adapted.size).toBe(real.size);
    expect(asCatalog(foreign)).toBe(adapted);
    expect(asCatalog(real)).toBe(real);
  });
});

// ----------------------------------------------------------------------------- pool

describe('computePool', () => {
  it('derives comfort from masteries and recent games', () => {
    const cat = smallCatalog();
    const now = 1_700_000_000_000;
    const pool = computePool(
      [
        { champion_id: 'Ahri', level: 7, points: 150_000, last_play_time: now },
        { champion_id: 'Zed', level: 7, points: 150_000, last_play_time: now - 400 * 86_400_000 },
        { champion_id: 'Lulu', level: 2, points: 3_000, last_play_time: now },
      ],
      [{ champion_id: 'Lulu', games: 8, wins: 6, kills: 0, deaths: 0, assists: 0 }],
      [],
      NO_PREFS,
      cat,
    );
    const by = new Map(pool.map((p) => [p.champion_id, p]));
    expect(by.get('Ahri')!.comfort).toBeGreaterThan(by.get('Zed')!.comfort);
    expect(by.get('Ahri')!.mastery_points).toBe(150_000);
    expect(by.get('Lulu')!.comfort).toBeGreaterThan(0.6);
    expect(new Set(by.get('Lulu')!.sources)).toEqual(new Set(['mastery', 'recent']));
    const comforts = pool.map((p) => p.comfort);
    expect(comforts).toEqual([...comforts].sort((a, b) => b - a));
    for (const p of pool) {
      expect(p.comfort >= 0 && p.comfort <= 1 && p.desire >= 0 && p.desire <= 1).toBe(true);
    }
  });

  it('applies preferences, manual entries and avoided champions', () => {
    const cat = smallCatalog();
    const pool = computePool(
      [
        { champion_id: 'Ahri', level: 7, points: 150_000 },
        { champion_id: 'Yasuo', level: 7, points: 300_000 },
      ],
      [],
      [
        { champion_id: 'Ahri', comfort: 0.2 },
        { champion_id: 'Veigar', comfort: 0.8 },
      ],
      { roles: [], wanted_champions: ['Lulu'], wanted_archetypes: ['assassin'], avoided_champions: ['Yasuo'] },
      cat,
    );
    const by = new Map(pool.map((p) => [p.champion_id, p]));
    expect(by.has('Yasuo')).toBe(false);
    expect(by.get('Ahri')!.comfort).toBe(0.2);
    expect(by.get('Veigar')!.comfort).toBe(0.8);
    expect(by.get('Veigar')!.sources).toEqual(['manual']);
    expect(by.get('Lulu')!.desire).toBe(1.0);
    expect(by.get('Lulu')!.comfort).toBe(0);
    expect(by.get('Lulu')!.sources).toContain('wanted');
    expect(by.get('Zed')!.desire).toBeGreaterThanOrEqual(0.6);
    expect(by.get('Khazix')!.comfort).toBe(0);
    expect(pool[0].champion_id).toBe('Veigar');
  });
});

// ----------------------------------------------------------------------------- generator

const ids = (s: CompositionSuggestion): string[] => s.picks.map((p) => p.champion_id);

function checkValid(res: CompositionSuggestion[], players: PlayerInput[], cat: Catalog, opts: GenerationOptions): void {
  for (const s of res) {
    const roles = s.picks.map((p) => p.role);
    const champs = ids(s);
    expect(s.picks.length).toBe(players.length);
    expect(new Set(roles).size).toBe(roles.length);
    expect(new Set(champs).size).toBe(champs.length);
    expect(new Set(s.picks.map((p) => p.player_id))).toEqual(new Set(players.map((p) => p.player_id)));
    for (const p of s.picks) {
      expect(opts.bans ?? []).not.toContain(p.champion_id);
      expect(opts.enemy_champions ?? []).not.toContain(p.champion_id);
      const info = cat.get(p.champion_id)!;
      if (!(p.player_id! in (opts.locked_picks ?? {}))) expect(info.roles).toContain(p.role);
      expect(p.reasons.length).toBeGreaterThan(0);
    }
    expect(s.score >= 0 && s.score <= 100).toBe(true);
  }
}

describe('generateCompositions', () => {
  it('auto mode: diverse themes, sorted, favourite roles', () => {
    const cat = bigCatalog();
    const players = fivePlayers();
    const opts: GenerationOptions = { count: 5 };
    const res = generateCompositions(players, opts, cat);
    expect(res.length).toBe(5);
    checkValid(res, players, cat, opts);
    const scores = res.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(new Set(res.map((r) => r.theme)).size).toBe(5);
    expect(new Set(res.map((r) => [...ids(r)].sort().join(','))).size).toBe(5);
    const roles = Object.fromEntries(res[0].picks.map((p) => [p.player_id, p.role]));
    expect(roles).toEqual({ alice: 'TOP', bob: 'JUNGLE', carl: 'MID', dana: 'BOTTOM', eve: 'SUPPORT' });
  });

  it('respects bans, locks, forced roles and avoided champions', () => {
    const cat = bigCatalog();
    const players = fivePlayers();
    players[2].preferences.avoided_champions = ['Orianna'];
    const opts: GenerationOptions = {
      theme: 'engage',
      bans: ['Malphite', 'Leona'],
      enemy_champions: ['Jinx'],
      locked_picks: { bob: 'Amumu' },
      role_assignments: { alice: 'SUPPORT', eve: 'TOP' },
      count: 4,
    };
    const res = generateCompositions(players, opts, cat);
    expect(res.length).toBe(4);
    checkValid(res, players, cat, opts);
    for (const s of res) {
      const by = Object.fromEntries(s.picks.map((p) => [p.player_id, p]));
      expect(by.bob.champion_id).toBe('Amumu');
      expect(by.bob.reasons).toContain('Choix verrouillé');
      expect(by.alice.role).toBe('SUPPORT');
      expect(by.eve.role).toBe('TOP');
      expect(ids(s)).not.toContain('Orianna');
      expect(s.breakdown.counter).not.toBeNull();
    }
  });

  it('respects a thematic theme when feasible', () => {
    const cat = bigCatalog();
    const res = generateCompositions(fivePlayers(), { theme: 'yordles', count: 3 }, cat);
    const theme = getTheme('yordles')!;
    expect(res.length).toBeGreaterThan(0);
    for (const s of res) {
      expect(s.theme).toBe('yordles');
      const champs = ids(s).map((c) => cat.data(c)!);
      expect(theme.satisfied(champs)).toBe(true);
      expect(champs.filter((c) => c.groups.has('yordle')).length).toBeGreaterThanOrEqual(3);
    }
    expect(res[0].strengths.some((x) => x.includes('Thème respecté'))).toBe(true);
  });

  it('full AP theme only uses AP/mixed champions', () => {
    const cat = bigCatalog();
    for (const s of generateCompositions(fivePlayers(), { theme: 'full_ap', count: 2 }, cat)) {
      for (const c of ids(s)) expect(['AP', 'MIXED']).toContain(cat.get(c)!.damage_type);
    }
  });

  it('is deterministic', () => {
    const cat = bigCatalog();
    const opts: GenerationOptions = { count: 6, exploration: 0.5 };
    expect(generateCompositions(fivePlayers(), opts, cat)).toEqual(generateCompositions(fivePlayers(), opts, cat));
  });

  it('honours count with fewer players; empty input gives no result', () => {
    const cat = bigCatalog();
    const players = fivePlayers().slice(0, 2);
    const res = generateCompositions(players, { theme: 'dive', count: 7 }, cat);
    expect(res.length).toBe(7);
    checkValid(res, players, cat, {});
    expect(generateCompositions([], {}, cat)).toEqual([]);
  });

  it('produces valid lineups from empty pools', () => {
    const cat = smallCatalog();
    const players: PlayerInput[] = [0, 1, 2, 3, 4].map((i) => ({
      player_id: `p${i}`,
      name: `P${i}`,
      preferences: NO_PREFS,
      role_games: {},
      pool: [],
    }));
    const opts: GenerationOptions = { count: 3, exploration: 0 };
    const res = generateCompositions(players, opts, cat);
    expect(res.length).toBe(3);
    checkValid(res, players, cat, opts);
  });

  it('explores wanted archetypes', () => {
    const cat = smallCatalog();
    const p = player('solo', ['MID'], { Orianna: 0.9 }, { wanted_archetypes: ['assassin'] });
    p.pool.push({ champion_id: 'Zed', comfort: 0.0, desire: 0.6, sources: ['wanted'] });
    const res = generateCompositions([p], { theme: 'pick', count: 3, exploration: 0.6 }, cat);
    expect(res.map((s) => ids(s)[0])).toContain('Zed');
    const zed = res.find((s) => ids(s)[0] === 'Zed')!.picks[0];
    expect(zed.reasons.some((r) => r.includes('Correspond à ton envie : '))).toBe(true);
  });

  it('rejects more than 5 players', () => {
    expect(() =>
      generateCompositions([...fivePlayers(), fivePlayers()[0]], {}, smallCatalog()),
    ).toThrowError('Une composition compte au plus 5 joueurs');
  });
});

// ----------------------------------------------------------------------------- performance

describe('performance', () => {
  it('auto mode with 5 players and 40-champion pools runs under 1 s', () => {
    const cat = bigCatalog();
    const allIds = cat.all().map((c) => c.id).sort();
    const players = ROLES.map((role, i) => {
      const pool: Record<string, number> = {};
      allIds.slice(i * 25, i * 25 + 40).forEach((cid, k) => (pool[cid] = pyRound(0.95 - 0.02 * k, 2)));
      return player(`p${i}`, [role], pool);
    });
    for (const theme of [null, 'engage', 'yordles']) {
      const t0 = performance.now();
      const res = generateCompositions(players, { theme, count: 5, exploration: 0.3 }, cat);
      const elapsed = performance.now() - t0;
      expect(res.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(1000);
    }
  });

  it('auto mode on the real data with 40-champion pools runs under 1 s', () => {
    const cat = buildCatalog([], 'offline');
    const players = ROLES.map((role, i) => {
      const champs = cat.all().filter((c) => c.roles.includes(role));
      const masteries = champs
        .slice(i * 3, i * 3 + 40)
        .map((c, k) => ({ champion_id: c.id, level: 7, points: 200_000 - 4_000 * k }));
      const prefs = { ...NO_PREFS, roles: [role, ROLES[(i + 1) % 5]] };
      return { player_id: `p${i}`, name: `P${i}`, preferences: prefs, role_games: {}, pool: computePool(masteries, [], [], prefs, cat) };
    });
    const t0 = performance.now();
    const res = generateCompositions(players, { count: 5, exploration: 0.3 }, cat);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(res.length).toBe(5);
  });
});

// ----------------------------------------------------------------------------- plans

const lineup = (champs: string[]): Pick[] => champs.map((c, i) => ({ role: ROLES[i], champion_id: c }));
const ALLY = lineup(['Malphite', 'JarvanIV', 'Orianna', 'Jinx', 'Leona']);
const ENEMY = lineup(['Fiora', 'Khazix', 'Xerath', 'Ezreal', 'Lulu']);

describe('plans', () => {
  it('game plan of an engage comp', () => {
    const plan = buildGamePlan(ALLY, smallCatalog());
    expect(plan.detected_themes[0]).toBe('engage');
    expect(plan.identity).toContain('Engage');
    expect(plan.win_conditions.length && plan.objectives.length && plan.avoid.length).toBeTruthy();
    expect(plan.phases.map((p) => p.phase)).toEqual(['early', 'mid', 'late']);
    expect(plan.phases.every((p) => p.summary)).toBe(true);
    expect(plan.power_spikes.length).toBe(5);
    expect(plan.key_combos.some((c) => c.includes('Orianna') && c.includes('Malphite'))).toBe(true);
    expect(plan.role_tips.length).toBe(5);
    expect(plan.role_tips.every((t) => t.tips.length)).toBe(true);
    const total = Object.values(plan.damage_profile).reduce((a, b) => a + b, 0);
    expect(Math.abs(total - 1)).toBeLessThan(1e-6);
    expect(plan.damage_profile.AP).toBeGreaterThan(0);
    expect(plan.damage_profile.AD).toBeGreaterThan(0);
  });

  it('thematic plan and Yasuo combo', () => {
    const plan = buildGamePlan(lineup(['Gnar', 'Poppy', 'Veigar', 'Tristana', 'Lulu']), smallCatalog());
    expect(plan.detected_themes).toContain('yordles');
    const combo = buildGamePlan(
      [
        { role: 'TOP', champion_id: 'Malphite' },
        { role: 'MID', champion_id: 'Yasuo' },
      ],
      smallCatalog(),
    );
    expect(combo.key_combos.some((c) => c.includes('Yasuo') && c.includes('Malphite'))).toBe(true);
  });

  it('empty and unknown lineups', () => {
    expect(buildGamePlan([], smallCatalog()).identity).toBeTruthy();
    const plan = buildGamePlan([{ role: 'MID', champion_id: 'Unknown' }], smallCatalog());
    expect(plan.role_tips[0].champion_id).toBe('Unknown');
  });

  it('matchup plan', () => {
    const plan = buildMatchupPlan(ALLY, ENEMY, smallCatalog());
    expect(plan.enemy_identity.startsWith('Compo adverse')).toBe(true);
    expect(plan.enemy_themes.length && plan.enemy_win_conditions.length && plan.how_to_win.length).toBeTruthy();
    expect(plan.threats.length).toBeGreaterThanOrEqual(2);
    expect(plan.threats.length).toBeLessThanOrEqual(4);
    expect(plan.threats[0].danger).toBeGreaterThanOrEqual(2);
    expect(plan.threats.every((t) => t.why && t.how_to_handle)).toBe(true);
    const enemyIds = new Set(ENEMY.map((p) => p.champion_id));
    expect(plan.threats.every((t) => enemyIds.has(t.champion_id))).toBe(true);
    expect(plan.lane_matchups.length).toBe(5);
    expect(plan.lane_matchups.every((m) => m.advice)).toBe(true);
    expect(plan.objectives.length).toBeGreaterThan(0);
    expect(plan.suggested_bans.length).toBeGreaterThan(0);
    const taken = new Set([...enemyIds, ...ALLY.map((p) => p.champion_id)]);
    expect(plan.suggested_bans.some((b) => taken.has(b))).toBe(false);
  });

  it('matchup plan without enemy still suggests bans', () => {
    const plan = buildMatchupPlan(ALLY, [], smallCatalog());
    expect(plan.suggested_bans.length).toBeGreaterThan(0);
    expect(plan.threats).toEqual([]);
  });
});

// ----------------------------------------------------------------------------- curated data + smoke

describe('curated data', () => {
  const champs = championsMeta as unknown as Record<string, Record<string, unknown>>;

  it('has well-formed champions and archetypes', () => {
    expect(Object.keys(champs).length).toBeGreaterThanOrEqual(160);
    expect((archetypesData as unknown[]).length).toBe(13);
    const archKeys = new Set((archetypesData as { key: string }[]).map((a) => a.key));
    const keys = new Set<number>();
    for (const [cid, c] of Object.entries(champs)) {
      expect(archKeys.has(c.archetype as string), cid).toBe(true);
      expect(['AD', 'AP', 'MIXED']).toContain(c.damage_type);
      expect((c.roles as string[]).length, cid).toBeGreaterThan(0);
      for (const v of Object.values(c.traits as Record<string, number>)) expect(v >= 0 && v <= 3).toBe(true);
      keys.add(c.key as number);
    }
    expect(keys.size).toBe(Object.keys(champs).length);
  });

  it('every theme generates on the real data and plans work', () => {
    const cat = buildCatalog([], '');
    expect(cat.size).toBeGreaterThan(100);
    const players = ROLES.map((role, i) => {
      const list = cat.all().filter((c) => c.roles.includes(role));
      const masteries = list.slice(i * 3, i * 3 + 40).map((c, k) => ({ champion_id: c.id, level: 7, points: 200_000 - 4_000 * k }));
      const prefs = { ...NO_PREFS, roles: [role, ROLES[(i + 1) % 5]], wanted_archetypes: i === 2 ? ['assassin'] : [] };
      return { player_id: `p${i}`, name: `P${i}`, preferences: prefs, role_games: {}, pool: computePool(masteries, [], [], prefs, cat) };
    });
    for (const theme of [null, ...listThemes().map((t) => t.key)]) {
      const res = generateCompositions(players, { theme, count: 3, exploration: 0.3 }, cat);
      expect(res.length, String(theme)).toBeGreaterThan(0);
      for (const s of res) {
        expect(new Set(s.picks.map((p) => p.champion_id)).size).toBe(5);
        expect(new Set(s.picks.map((p) => p.role)).size).toBe(5);
      }
    }
    const res = generateCompositions(players, { count: 2 }, cat);
    const ally = res[0].picks.map((p) => ({ role: p.role, champion_id: p.champion_id }));
    const enemy = res[1].picks.map((p) => ({ role: p.role, champion_id: p.champion_id }));
    const gp = buildGamePlan(ally, cat);
    expect(gp.identity && gp.win_conditions.length && gp.role_tips.length).toBeTruthy();
    const mp = buildMatchupPlan(ally, enemy, cat);
    expect(mp.threats.length && mp.lane_matchups.length && mp.suggested_bans.length).toBeTruthy();
  });
});
