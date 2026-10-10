// Recent form, high-elo meta, lane matchups and duo history: every factor, absent-data invariance, perf.
import { describe, expect, it } from 'vitest';
import type {
  CompositionSuggestion,
  EngineContext,
  GamesWins,
  GenerationOptions,
  MetaStats,
  Pick,
  PlayerInput,
  Role,
} from '../../api/types';
import {
  buildCatalog,
  buildMatchupPlan,
  computeForm,
  computePool,
  generateCompositions,
  guessEnemyRoles,
  META_MIN_GAMES,
} from '..';

const catalog = buildCatalog([], 'offline');
const ROLES: Role[] = ['TOP', 'JUNGLE', 'MID', 'BOTTOM', 'SUPPORT'];
const DAY = 86_400_000;
const NOW = 1_760_000_000_000;

const FRIENDS: [string, Role[], string[], [string, number][]][] = [
  ['Lucas', ['TOP', 'JUNGLE'], ['juggernaut', 'vanguard'], [['Darius', 0.9], ['Sett', 0.8], ['Ornn', 0.6], ['Garen', 0.7]]],
  ['Mags', ['JUNGLE', 'MID'], ['assassin', 'diver'], [['LeeSin', 0.8], ['Khazix', 0.7], ['JarvanIV', 0.6], ['Vi', 0.7]]],
  ['Theo', ['MID'], ['burst_mage', 'battlemage'], [['Ahri', 0.8], ['Syndra', 0.8], ['Orianna', 0.6], ['Lux', 0.8]]],
  ['Ines', ['BOTTOM'], ['marksman'], [['Jinx', 0.9], ['Caitlyn', 0.8], ['Ezreal', 0.7], ['Draven', 0.5]]],
  ['Sam', ['SUPPORT'], ['enchanter', 'catcher'], [['Thresh', 0.8], ['Lulu', 0.9], ['Leona', 0.6], ['Janna', 0.6]]],
];

const friendsBase = (): PlayerInput[] => friends();

function friends(): PlayerInput[] {
  return FRIENDS.map(([name, roles, archetypes, pool]) => {
    const preferences = { roles, wanted_archetypes: archetypes, wanted_champions: [], avoided_champions: [] };
    const manual = pool.map(([champion_id, comfort]) => ({ champion_id, comfort }));
    return { player_id: name, name, preferences, role_games: {}, pool: computePool([], [], manual, preferences, catalog) };
  });
}

function withForm(players: PlayerInput[], who: string, forms: Record<string, number>): PlayerInput[] {
  return players.map((p) =>
    p.player_id !== who ? p : { ...p, pool: p.pool.map((e) => (e.champion_id in forms ? { ...e, form: forms[e.champion_id] } : e)) },
  );
}

/** Neutral meta: every champion in each of its roles, 50 % winrate, same presence. */
function neutralMeta(games = 5000): MetaStats {
  const champions: MetaStats['champions'] = {};
  for (const c of catalog.all()) {
    champions[c.id] = {};
    for (const r of c.roles) champions[c.id][r] = [200, 100];
  }
  return { patch: '16.19', platform: 'euw1', games, updated_at: '2026-10-10T12:00:00Z', champions, bans: {}, matchups: {} };
}

function setStat(meta: MetaStats, cid: string, role: Role, v: GamesWins): void {
  (meta.champions[cid] ??= {})[role] = v;
}

function setDuel(meta: MetaStats, role: Role, a: string, b: string, games: number, winsA: number): void {
  const byRole = (meta.matchups[role] ??= {});
  (byRole[a] ??= {})[b] = [games, winsA];
  (byRole[b] ??= {})[a] = [games, games - winsA];
}

function count(res: CompositionSuggestion[], cid: string): number {
  return res.flatMap((s) => s.picks).filter((p) => p.champion_id === cid).length;
}

function pairCount(res: CompositionSuggestion[], a: string, b: string): number {
  return res.filter((s) => s.picks.some((p) => p.champion_id === a) && s.picks.some((p) => p.champion_id === b)).length;
}

const json = (x: unknown): string => JSON.stringify(x);

// ----------------------------------------------------------------------------- form

describe('recent form', () => {
  it('is 0 without games, signed by results and KDA, within [-1, 1]', () => {
    expect(computeForm(0, 0, 0, 0, 0, null, null)).toBe(0);
    const good = computeForm(10, 8, 8, 2, 8, NOW, NOW);
    const bad = computeForm(10, 2, 2, 8, 3, NOW, NOW);
    expect(good).toBeGreaterThan(0.4);
    expect(bad).toBeLessThan(-0.4);
    expect(computeForm(1000, 1000, 30, 0, 30, NOW, NOW)).toBeLessThanOrEqual(1);
    expect(computeForm(1000, 0, 0, 30, 0, NOW, NOW)).toBeGreaterThanOrEqual(-1);
    // neutral: 50 % and KDA 2.5
    expect(computeForm(10, 5, 3, 2, 2, NOW, NOW)).toBeCloseTo(0, 10);
    // missing k/d/a (all zero) is not read as a terrible KDA
    expect(computeForm(10, 5, 0, 0, 0, NOW, NOW)).toBeCloseTo(0, 10);
  });

  it('is shrunk toward 0 for small samples', () => {
    const one = computeForm(1, 1, 8, 2, 8, NOW, NOW);
    const eight = computeForm(8, 8, 8, 2, 8, NOW, NOW);
    expect(one).toBeGreaterThan(0);
    expect(one).toBeLessThan(eight / 2);
  });

  it('fades with the age of the last game', () => {
    const fresh = computeForm(8, 7, 8, 2, 8, NOW - 3 * DAY, NOW);
    const month = computeForm(8, 7, 8, 2, 8, NOW - 40 * DAY, NOW);
    const old = computeForm(8, 7, 8, 2, 8, NOW - 120 * DAY, NOW);
    expect(fresh).toBeGreaterThan(month);
    expect(month).toBeGreaterThan(0);
    expect(old).toBe(0);
  });

  it('computePool sets form only when recent stats carry last_played, comfort unchanged', () => {
    const prefs = { roles: [], wanted_archetypes: [], wanted_champions: [], avoided_champions: [] };
    const recent = [
      { champion_id: 'Ahri', games: 9, wins: 7, kills: 7, deaths: 2, assists: 6, role: 'MID' as Role },
      { champion_id: 'Lux', games: 6, wins: 1, kills: 2, deaths: 7, assists: 4, role: 'MID' as Role },
    ];
    const old = computePool([], recent, [], prefs, catalog);
    expect(old.every((e) => !('form' in e))).toBe(true);
    const dated = recent.map((r, i) => ({ ...r, last_played: NOW - i * DAY }));
    const pool = computePool([], dated, [], prefs, catalog);
    const ahri = pool.find((e) => e.champion_id === 'Ahri')!;
    const lux = pool.find((e) => e.champion_id === 'Lux')!;
    expect(ahri.form!).toBeGreaterThan(0.3);
    expect(lux.form!).toBeLessThan(-0.3);
    expect(pool.map((e) => [e.champion_id, e.comfort, e.desire])).toEqual(old.map((e) => [e.champion_id, e.comfort, e.desire]));
  });

  it('default nowMs includes recent last_played (stale masteries decay)', () => {
    const prefs = { roles: [], wanted_archetypes: [], wanted_champions: [], avoided_champions: [] };
    const masteries = [{ champion_id: 'Garen', level: 7, points: 200_000, last_play_time: NOW - 400 * DAY }];
    const recent = [{ champion_id: 'Ahri', games: 3, wins: 2, kills: 5, deaths: 3, assists: 5, last_played: NOW }];
    const before = computePool(masteries, [], [], prefs, catalog).find((e) => e.champion_id === 'Garen')!;
    const after = computePool(masteries, recent, [], prefs, catalog).find((e) => e.champion_id === 'Garen')!;
    expect(after.comfort).toBeLessThan(before.comfort);
    expect(computePool(masteries, recent, [], prefs, catalog, NOW)).toEqual(computePool(masteries, recent, [], prefs, catalog));
  });
});

// ----------------------------------------------------------------------------- generator

describe('generator with history and meta', () => {
  const opts: GenerationOptions = { count: 5, exploration: 0 };

  it('absent data = identical output', () => {
    const base = generateCompositions(friends(), opts, catalog);
    const emptyHistory = friends().map((p) => ({ ...p, puuid: null, lane_history: [], allies: [] }));
    expect(json(generateCompositions(emptyHistory, opts, catalog, {}))).toBe(json(base));
    expect(json(generateCompositions(friends(), opts, catalog, { meta: null, players: [] }))).toBe(json(base));
    // too few games: the meta snapshot is ignored
    const thin = neutralMeta(META_MIN_GAMES - 1);
    setStat(thin, 'Lux', 'MID', [400, 300]);
    expect(json(generateCompositions(friends(), opts, catalog, { meta: thin }))).toBe(json(base));
    expect(base.every((s) => !('meta' in s.breakdown))).toBe(true);
    // enemies without meta or lane history: trait counter only
    const vs = { ...opts, enemy_champions: ['Zed', 'Malphite'] };
    expect(json(generateCompositions(emptyHistory, vs, catalog, { meta: null }))).toBe(json(generateCompositions(friends(), vs, catalog)));
  });

  it('positive form favours a champion, negative form disfavours it', () => {
    const base = generateCompositions(friends(), opts, catalog);
    const up = generateCompositions(withForm(friends(), 'Theo', { Lux: 1, Ahri: -1, Syndra: -1 }), opts, catalog);
    const down = generateCompositions(withForm(friends(), 'Theo', { Lux: -1, Ahri: 1, Syndra: 1 }), opts, catalog);
    expect(count(up, 'Lux')).toBeGreaterThan(count(base, 'Lux'));
    expect(count(down, 'Lux')).toBeLessThan(count(up, 'Lux'));
    // no history sentence in the reasons: same reasons as without form for the same pick in the same lineup
    const key = (s: CompositionSuggestion) => s.picks.map((p) => `${p.role}:${p.champion_id}`).join(',');
    const baseByKey = new Map(base.map((s) => [`${s.theme}|${key(s)}`, s]));
    let compared = 0;
    for (const s of [...up, ...down]) {
      const b = baseByKey.get(`${s.theme}|${key(s)}`);
      if (!b) continue;
      compared += 1;
      expect(s.picks.map((p) => p.reasons)).toEqual(b.picks.map((p) => p.reasons));
    }
    expect(compared).toBeGreaterThan(0);
  });

  it('meta: strong patch picks rise, breakdown.meta is exposed (0..100)', () => {
    const neutral = neutralMeta();
    const a = generateCompositions(friends(), opts, catalog, { meta: neutral });
    expect(a.every((s) => typeof s.breakdown.meta === 'number' && s.breakdown.meta >= 0 && s.breakdown.meta <= 100)).toBe(true);
    const strong = neutralMeta();
    setStat(strong, 'Orianna', 'MID', [1500, 870]); // 58 %, very present
    strong.bans.Orianna = 900;
    setStat(strong, 'Ahri', 'MID', [1500, 660]); // 44 %
    setStat(strong, 'Syndra', 'MID', [1500, 660]);
    setStat(strong, 'Lux', 'MID', [1500, 660]);
    const b = generateCompositions(friends(), opts, catalog, { meta: strong });
    expect(count(b, 'Orianna')).toBeGreaterThan(count(a, 'Orianna'));
    const metaOf = (r: CompositionSuggestion[], cid: string) => r.find((s) => s.picks.some((p) => p.champion_id === cid))?.breakdown.meta;
    expect(metaOf(b, 'Orianna')!).toBeGreaterThan(metaOf(a, 'Orianna') ?? 0);
  });

  it('duo synergy: a winning champion pair of two players is favoured', () => {
    const duo = (wins: number): PlayerInput[] =>
      friends().map((p) => {
        if (p.player_id === 'Ines') {
          return {
            ...p,
            puuid: 'puuid-ines',
            allies: [{ puuid: 'puuid-sam', games: 12, wins, pairs: [{ champion_id: 'Ezreal', ally_champion_id: 'Janna', games: 12, wins }] }],
          };
        }
        if (p.player_id === 'Sam') return { ...p, puuid: 'puuid-sam' };
        return p;
      });
    const base = generateCompositions(friends(), opts, catalog);
    const good = generateCompositions(duo(11), opts, catalog);
    const bad = generateCompositions(duo(1), opts, catalog);
    expect(pairCount(good, 'Ezreal', 'Janna')).toBeGreaterThan(pairCount(base, 'Ezreal', 'Janna'));
    expect(pairCount(bad, 'Ezreal', 'Janna')).toBeLessThanOrEqual(pairCount(base, 'Ezreal', 'Janna'));
    // listed by one player only (the other synced earlier) or by both: same result, no double count
    const both = duo(11).map((p) =>
      p.player_id === 'Sam'
        ? {
            ...p,
            allies: [{ puuid: 'puuid-ines', games: 12, wins: 11, pairs: [{ champion_id: 'Janna', ally_champion_id: 'Ezreal', games: 12, wins: 11 }] }],
          }
        : p,
    );
    expect(json(generateCompositions(both, opts, catalog))).toBe(json(good));
    const samOnly = both.map((p) => (p.player_id === 'Ines' ? { ...p, allies: [] } : p));
    expect(json(generateCompositions(samOnly, opts, catalog))).toBe(json(good));
    // unmatched puuid: no effect
    const stranger = duo(11).map((p) => (p.player_id === 'Sam' ? { ...p, puuid: 'someone-else' } : p));
    expect(json(generateCompositions(stranger, opts, catalog))).toBe(json(base));
  });

  it('counter: meta lane matchups and own lane history move the mid pick', () => {
    const vs: GenerationOptions = { ...opts, enemy_champions: ['Zed'] }; // guessed MID
    // Theo knows his four mages equally well
    const friends = () =>
      friendsBase().map((p) =>
        p.player_id === 'Theo' ? { ...p, pool: p.pool.map((e) => (e.champion_id === 'Orianna' ? { ...e, comfort: 0.8 } : e)) } : p,
      );
    const base = generateCompositions(friends(), vs, catalog);
    const meta = neutralMeta();
    setDuel(meta, 'MID', 'Orianna', 'Zed', 600, 372); // 62 %
    setDuel(meta, 'MID', 'Ahri', 'Zed', 600, 228);
    setDuel(meta, 'MID', 'Syndra', 'Zed', 600, 228);
    setDuel(meta, 'MID', 'Lux', 'Zed', 600, 228);
    const neutral = generateCompositions(friends(), vs, catalog, { meta: neutralMeta() });
    const withDuels = generateCompositions(friends(), vs, catalog, { meta });
    expect(count(withDuels, 'Orianna')).toBeGreaterThan(count(neutral, 'Orianna'));
    const counterOf = (r: CompositionSuggestion[], cid: string) =>
      Math.max(...r.filter((s) => s.picks.some((p) => p.champion_id === cid)).map((s) => s.breakdown.counter!));
    expect(counterOf(withDuels, 'Orianna')).toBeGreaterThan(counterOf(neutral, 'Orianna'));

    // own lane history (no meta)
    const hist = (wins: number) =>
      friends().map((p) =>
        p.player_id === 'Theo'
          ? { ...p, lane_history: [{ champion_id: 'Orianna', opponent_id: 'Zed', role: 'MID' as Role, games: 6, wins }] }
          : p,
      );
    const won = generateCompositions(hist(6), vs, catalog);
    const lost = generateCompositions(hist(0), vs, catalog);
    expect(count(won, 'Orianna')).toBeGreaterThan(count(base, 'Orianna'));
    expect(count(lost, 'Orianna')).toBeLessThanOrEqual(count(base, 'Orianna'));
    // history against another opponent: no effect
    const other = friends().map((p) =>
      p.player_id === 'Theo' ? { ...p, lane_history: [{ champion_id: 'Orianna', opponent_id: 'Ahri', role: 'MID' as Role, games: 6, wins: 6 }] } : p,
    );
    expect(json(generateCompositions(other, vs, catalog))).toBe(json(base));
  });

  it('is deterministic with every factor on', () => {
    const ctx: EngineContext = { meta: fullMeta() };
    const run = () => generateCompositions(fullPlayers(), { count: 5, enemy_champions: ['Zed', 'Malphite', 'Jinx'] }, catalog, ctx);
    expect(json(run())).toBe(json(run()));
  });

  for (const theme of [null, 'engage']) {
    it(`exploration keeps its target share of new champions with meta and form (theme ${theme ?? 'auto'})`, () => {
      const known = new Map(FRIENDS.map(([name, , , pool]) => [name, new Set(pool.map(([c]) => c))]));
      let players = friends();
      for (const [name, , , pool] of FRIENDS) players = withForm(players, name, { [pool[0][0]]: 0.8, [pool[1][0]]: -0.5 });
      const ctx: EngineContext = { meta: fullMeta() };
      const share = (exploration: number) => {
        const picks = generateCompositions(players, { theme, count: 5, exploration }, catalog, ctx).flatMap((s) => s.picks);
        return picks.filter((p) => !known.get(p.player_id!)!.has(p.champion_id)).length / picks.length;
      };
      for (const x of [0, 0.2, 0.4, 0.6, 0.8, 1]) expect(share(x)).toBe(x);
    });
  }
});

// ----------------------------------------------------------------------------- enemy roles

describe('guessEnemyRoles', () => {
  it('keeps explicit roles, then first free catalog role, then first free role', () => {
    expect(guessEnemyRoles([{ champion_id: 'Malphite' }, { champion_id: 'Darius' }], catalog)).toEqual(['TOP', 'JUNGLE']);
    expect(
      guessEnemyRoles([{ champion_id: 'Malphite' }, { champion_id: 'Darius', role: 'TOP' }, { champion_id: 'Jinx' }], catalog),
    ).toEqual(['SUPPORT', 'TOP', 'BOTTOM']);
    expect(guessEnemyRoles([{ champion_id: 'Unknown' }], catalog)).toEqual(['TOP']);
    const six = ['Darius', 'Garen', 'Fiora', 'Sett', 'Ornn', 'Camille'].map((champion_id) => ({ champion_id }));
    // Sett (TOP SUPPORT) takes its free catalog role, Ornn (TOP) the first free one
    expect(guessEnemyRoles(six, catalog)).toEqual(['TOP', 'JUNGLE', 'MID', 'SUPPORT', 'BOTTOM', null]);
  });
});

// ----------------------------------------------------------------------------- matchup plan

describe('matchup plan with meta and lane history', () => {
  const ally: Pick[] = [
    { role: 'TOP', champion_id: 'Malphite', player_id: 'p-top' },
    { role: 'JUNGLE', champion_id: 'JarvanIV', player_id: null },
    { role: 'MID', champion_id: 'Orianna', player_id: 'p-mid' },
    { role: 'BOTTOM', champion_id: 'Jinx', player_id: null },
    { role: 'SUPPORT', champion_id: 'Leona', player_id: null },
  ];
  const enemy: Pick[] = [
    { role: 'TOP', champion_id: 'Fiora' },
    { role: 'JUNGLE', champion_id: 'Khazix' },
    { role: 'MID', champion_id: 'Xerath' },
    { role: 'BOTTOM', champion_id: 'Ezreal' },
    { role: 'SUPPORT', champion_id: 'Lulu' },
  ];
  const base = buildMatchupPlan(ally, enemy, catalog);
  const danger = (plan: typeof base, cid: string) => plan.threats.find((t) => t.champion_id === cid)!.danger;

  it('absent data = identical output', () => {
    expect(json(buildMatchupPlan(ally, enemy, catalog, {}))).toBe(json(base));
    expect(json(buildMatchupPlan(ally, enemy, catalog, { meta: null, players: [] }))).toBe(json(base));
    const thin = neutralMeta(META_MIN_GAMES - 1);
    setDuel(thin, 'MID', 'Orianna', 'Xerath', 400, 240);
    expect(json(buildMatchupPlan(ally, enemy, catalog, { meta: thin }))).toBe(json(base));
  });

  it('cites a meaningful meta duel in the lane advice, lowers the danger of a lost duel for them', () => {
    const meta = neutralMeta();
    setDuel(meta, 'MID', 'Orianna', 'Xerath', 412, 235); // 57 %
    setDuel(meta, 'TOP', 'Malphite', 'Fiora', 20, 15); // too few games to be cited
    const plan = buildMatchupPlan(ally, enemy, catalog, { meta });
    const mid = plan.lane_matchups.find((l) => l.role === 'MID')!;
    const baseMid = base.lane_matchups.find((l) => l.role === 'MID')!;
    expect(mid.advice).toBe(
      `${baseMid.advice} Sur ce patch (haut elo) : Orianna gagne 57 % de ses duels contre Xerath (412 parties).`,
    );
    expect(plan.lane_matchups.find((l) => l.role === 'TOP')!.advice).toBe(base.lane_matchups.find((l) => l.role === 'TOP')!.advice);
    expect(danger(base, 'Xerath')).toBe(2);
    expect(danger(plan, 'Xerath')).toBe(1);
    // the reverse entry is used when the direct one is missing
    const rev = neutralMeta();
    rev.matchups.MID = { Xerath: { Orianna: [412, 177] } };
    expect(buildMatchupPlan(ally, enemy, catalog, { meta: rev }).lane_matchups.find((l) => l.role === 'MID')!.advice).toBe(
      mid.advice,
    );
  });

  it('the cited sentence survives French elision unchanged', () => {
    const meta = neutralMeta();
    setDuel(meta, 'MID', 'Ahri', 'Orianna', 300, 150);
    const plan = buildMatchupPlan([{ role: 'MID', champion_id: 'Ahri' }], [{ role: 'MID', champion_id: 'Orianna' }], catalog, { meta });
    expect(plan.lane_matchups[0].advice).toContain('Ahri gagne 50 % de ses duels contre Orianna (300 parties).');
  });

  it("raises the danger when the ally player keeps losing that duel, without any history sentence", () => {
    const top: PlayerInput = {
      player_id: 'p-top',
      name: 'Top',
      preferences: { roles: ['TOP'], wanted_archetypes: [], wanted_champions: [], avoided_champions: [] },
      role_games: {},
      pool: [],
      lane_history: [{ champion_id: 'Malphite', opponent_id: 'Fiora', role: 'TOP', games: 4, wins: 0 }],
    };
    expect(danger(base, 'Fiora')).toBe(2);
    const plan = buildMatchupPlan(ally, enemy, catalog, { players: [top] });
    expect(danger(plan, 'Fiora')).toBe(3);
    const strip = (p: typeof base) => json({ ...p, threats: p.threats.map((t) => ({ ...t, danger: 0 })) });
    expect(strip(plan)).toBe(strip(base));
    // winning history lowers it; a player not in the lineup changes nothing
    const winner = { ...top, lane_history: [{ ...top.lane_history![0], wins: 4 }] };
    expect(danger(buildMatchupPlan(ally, enemy, catalog, { players: [winner] }), 'Fiora')).toBe(1);
    expect(json(buildMatchupPlan(ally, enemy, catalog, { players: [{ ...top, player_id: 'nobody' }] }))).toBe(json(base));
  });
});

// ----------------------------------------------------------------------------- performance

/** Every champion × every role + dense matchups (all pairs of champions listed in a role). */
function fullMeta(): MetaStats {
  const meta = neutralMeta(20000);
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (const c of catalog.all()) {
    for (const r of ROLES) {
      const g = 50 + Math.floor(rnd() * 3000);
      setStat(meta, c.id, r, [g, Math.floor(g * (0.44 + 0.12 * rnd()))]);
    }
    meta.bans[c.id] = Math.floor(rnd() * 4000);
  }
  for (const r of ROLES) {
    const ids = catalog.all().filter((c) => c.roles.includes(r)).map((c) => c.id);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const g = 10 + Math.floor(rnd() * 500);
        setDuel(meta, r, ids[i], ids[j], g, Math.floor(g * (0.4 + 0.2 * rnd())));
      }
    }
  }
  return meta;
}

/** 5 players with 40-champion pools (form + lane history) and allies data between all of them. */
function fullPlayers(): PlayerInput[] {
  const all = catalog.all();
  const players: PlayerInput[] = ROLES.map((role, i) => {
    const main = all.filter((c) => c.roles.includes(role));
    const ids = [...main, ...all.filter((c) => !c.roles.includes(role))].slice(0, 40).map((c) => c.id);
    const recent = ids.slice(0, 20).map((cid, k) => ({
      champion_id: cid,
      games: 1 + (k % 6),
      wins: k % 4,
      kills: 5,
      deaths: 1 + (k % 5),
      assists: 6,
      last_played: NOW - k * DAY,
    }));
    const manual = ids.slice(20).map((cid, k) => ({ champion_id: cid, comfort: 0.3 + (k % 5) * 0.1 }));
    const preferences = { roles: [role], wanted_archetypes: [], wanted_champions: [], avoided_champions: [] };
    return {
      player_id: `p${i}`,
      name: `P${i}`,
      puuid: `puuid-${i}`,
      preferences,
      role_games: { [role]: 20 },
      pool: computePool([], recent, manual, preferences, catalog),
      lane_history: ids.slice(0, 15).map((cid, k) => ({
        champion_id: cid,
        opponent_id: all[(k * 7) % all.length].id,
        role,
        games: 1 + (k % 3),
        wins: k % 2,
      })),
      allies: [],
    };
  });
  for (const p of players) {
    p.allies = players
      .filter((o) => o !== p)
      .map((o) => ({
        puuid: o.puuid!,
        games: 20,
        wins: 11,
        pairs: p.pool.slice(0, 15).flatMap((a, k) =>
          o.pool.slice(0, 4).map((b, m) => ({ champion_id: a.champion_id, ally_champion_id: b.champion_id, games: 1 + ((k + m) % 4), wins: (k + m) % 3 })),
        ),
      }));
  }
  return players;
}

describe('performance', () => {
  it('auto mode, 5 players, 40-champion pools, full meta, allies and enemies stays under 1 s', () => {
    const meta = fullMeta();
    const players = fullPlayers();
    const t0 = performance.now();
    const res = generateCompositions(players, { count: 5, enemy_champions: ['Zed', 'Malphite', 'Jinx', 'Thresh'] }, catalog, { meta });
    const ms = performance.now() - t0;
    expect(res.length).toBeGreaterThan(0);
    expect(res.every((s) => typeof s.breakdown.meta === 'number')).toBe(true);
    expect(ms).toBeLessThan(1000);
  });
});
