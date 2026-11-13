// Live draft advice: roles, exclusions, counters, synergy, bans, enemy analysis, accounts, determinism, perf.
import { describe, expect, it } from 'vitest';
import type {
  DraftAdvice,
  DraftAllySlot,
  DraftEnemyAccount,
  DraftEnemySlot,
  DraftInput,
  GamesWins,
  MetaStats,
  PlayerInput,
  Role,
} from '../../api/types';
import { buildCatalog, computePool, recommendDraft } from '..';

const catalog = buildCatalog([], 'offline');
const ROLES: Role[] = ['TOP', 'JUNGLE', 'MID', 'BOTTOM', 'SUPPORT'];
const DAY = 86_400_000;
const NOW = 1_760_000_000_000;

function friend(
  id: string,
  roles: Role[],
  pool: [string, number][],
  extra: Partial<PlayerInput> = {},
): PlayerInput {
  const preferences = { roles, wanted_archetypes: [], wanted_champions: [], avoided_champions: [] };
  const manual = pool.map(([champion_id, comfort]) => ({ champion_id, comfort }));
  return {
    player_id: id,
    name: id,
    preferences,
    role_games: {},
    pool: computePool([], [], manual, preferences, catalog),
    ...extra,
  };
}

const ally = (player_id: string | null, champion_id: string | null = null, locked = false, role: Role | null = null): DraftAllySlot => ({
  player_id,
  champion_id,
  locked,
  role,
});
const foe = (champion_id: string, role: Role | null = null): DraftEnemySlot => ({ champion_id, role, locked: true });

function draft(a: DraftAllySlot[], e: DraftEnemySlot[] = [], bans: string[] = [], accounts?: DraftEnemyAccount[]): DraftInput {
  return { ally: a, enemy: e, bans, ...(accounts ? { enemy_accounts: accounts } : {}) };
}

function neutralMeta(games = 5000): MetaStats {
  const champions: MetaStats['champions'] = {};
  for (const c of catalog.all()) {
    champions[c.id] = {};
    for (const r of c.roles) champions[c.id][r] = [200, 100];
  }
  return { patch: '16.21', platform: 'euw1', games, updated_at: '2026-11-01T12:00:00Z', champions, bans: {}, matchups: {} };
}

function setStat(meta: MetaStats, cid: string, role: Role, v: GamesWins): void {
  (meta.champions[cid] ??= {})[role] = v;
}

function setDuel(meta: MetaStats, role: Role, a: string, b: string, games: number, winsA: number): void {
  const byRole = (meta.matchups[role] ??= {});
  (byRole[a] ??= {})[b] = [games, winsA];
  (byRole[b] ??= {})[a] = [games, games - winsA];
}

const ids = (adv: DraftAdvice, pid: string): string[] =>
  adv.players.find((p) => p.player_id === pid)!.picks.map((p) => p.champion_id);
const pickOf = (adv: DraftAdvice, pid: string, cid: string) =>
  adv.players.find((p) => p.player_id === pid)!.picks.find((p) => p.champion_id === cid);
const roleOf = (adv: DraftAdvice, pid: string): Role | null => adv.players.find((p) => p.player_id === pid)!.role;

function allStrings(x: unknown, out: string[] = []): string[] {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) x.forEach((v) => allStrings(v, out));
  else if (x && typeof x === 'object') Object.values(x).forEach((v) => allStrings(v, out));
  return out;
}

const MID_POOL: [string, number][] = [
  ['Ahri', 0.8],
  ['Syndra', 0.8],
  ['Orianna', 0.8],
  ['Viktor', 0.8],
];

// ----------------------------------------------------------------------------- basics

describe('recommendDraft basics', () => {
  it('returns nothing useful for an empty draft and null enemy analysis without enemy pick', () => {
    const res = recommendDraft([], draft([]), catalog);
    expect(res).toEqual({ players: [], bans: [], enemy: null, predictions: [], pick_order: [], enemy_players: [] });
    const one = recommendDraft([friend('Theo', ['MID'], MID_POOL)], draft([ally('Theo')]), catalog);
    expect(one.enemy).toBeNull();
    expect(one.players).toHaveLength(1);
  });

  it('gives 3 to 5 picks per friend still to pick, scores 0..100 best first, short French reasons', () => {
    const players = [friend('Theo', ['MID'], MID_POOL), friend('Sam', ['SUPPORT'], [['Thresh', 0.8], ['Lulu', 0.9]])];
    const res = recommendDraft(players, draft([ally('Theo'), ally('Sam'), ally(null)], [foe('Zed')]), catalog);
    for (const p of res.players) {
      expect(p.picks.length).toBeGreaterThanOrEqual(3);
      expect(p.picks.length).toBeLessThanOrEqual(5);
      for (const k of p.picks) {
        expect(k.score).toBeGreaterThanOrEqual(0);
        expect(k.score).toBeLessThanOrEqual(100);
        expect(k.comfort).toBeGreaterThanOrEqual(0);
        expect(k.reasons.length).toBeGreaterThan(0);
        for (const r of k.reasons) expect(r.length).toBeLessThan(120);
      }
      const known = p.picks.filter((k) => k.comfort >= 0.15);
      for (let i = 1; i < known.length; i++) expect(known[i - 1].score).toBeGreaterThanOrEqual(known[i].score);
    }
    // Sam only knows two supports: completed with a third option
    expect(ids(res, 'Sam').slice(0, 2).sort()).toEqual(['Lulu', 'Thresh']);
  });

  it('known champions come first, with mastery points in the reasons', () => {
    const prefs = { roles: ['MID' as Role], wanted_archetypes: [], wanted_champions: [], avoided_champions: [] };
    const pool = computePool([{ champion_id: 'Ahri', level: 7, points: 124_000 }], [], [], prefs, catalog);
    const theo: PlayerInput = { player_id: 'Theo', name: 'Theo', preferences: prefs, role_games: {}, pool };
    const res = recommendDraft([theo], draft([ally('Theo')]), catalog);
    expect(ids(res, 'Theo')[0]).toBe('Ahri');
    expect(pickOf(res, 'Theo', 'Ahri')!.reasons).toContain('Champion maîtrisé (124k points)');
  });

  it('a locked friend gets no recommendation, a hovering friend sees the hovered champion', () => {
    const players = [friend('Theo', ['MID'], MID_POOL), friend('Ines', ['BOTTOM'], [['Jinx', 0.9], ['Caitlyn', 0.8]])];
    const res = recommendDraft(players, draft([ally('Ines', 'Jinx', true), ally('Theo', 'Lux', false)]), catalog);
    const ines = res.players.find((p) => p.player_id === 'Ines')!;
    expect(ines.locked_champion_id).toBe('Jinx');
    expect(ines.picks).toEqual([]);
    expect(ines.role).toBe('BOTTOM');
    const lux = pickOf(res, 'Theo', 'Lux');
    expect(lux).toBeDefined();
    expect(lux!.reasons[0]).toBe('Ton choix actuel (survol)');
  });
});

// ----------------------------------------------------------------------------- roles

describe('role assignment', () => {
  it('keeps the slot role even against preferences', () => {
    const res = recommendDraft([friend('Theo', ['MID'], MID_POOL)], draft([ally('Theo', null, false, 'TOP')]), catalog);
    expect(roleOf(res, 'Theo')).toBe('TOP');
    for (const cid of ids(res, 'Theo')) expect(catalog.get(cid)!.roles).toContain('TOP');
  });

  it('gives the best free role: preferred role unless taken by a locked ally', () => {
    const theo = friend('Theo', ['MID', 'TOP'], [...MID_POOL, ['Darius', 0.7]]);
    expect(roleOf(recommendDraft([theo], draft([ally('Theo')]), catalog), 'Theo')).toBe('MID');
    // an unknown teammate locked Syndra (MID only, role guessed) -> Theo goes TOP
    const res = recommendDraft([theo], draft([ally(null, 'Syndra', true), ally('Theo')]), catalog);
    expect(roleOf(res, 'Theo')).toBe('TOP');
    expect(ids(res, 'Theo')).not.toContain('Syndra');
    // an explicit teammate role is taken too
    const res2 = recommendDraft([theo], draft([ally(null, null, false, 'MID'), ally('Theo')]), catalog);
    expect(roleOf(res2, 'Theo')).toBe('TOP');
  });

  it('never gives two friends the same role (best total fit)', () => {
    const a = friend('A', ['MID', 'TOP'], [['Ahri', 0.8], ['Darius', 0.8]]);
    const b = friend('B', ['MID'], [['Syndra', 0.8]]);
    const res = recommendDraft([a, b], draft([ally('A'), ally('B')]), catalog);
    expect(roleOf(res, 'B')).toBe('MID');
    expect(roleOf(res, 'A')).toBe('TOP');
  });

  it('uses role games when there are no preferences, and the hover breaks ties', () => {
    const p = friend('P', [], [['Jinx', 0.6], ['Thresh', 0.6]], { role_games: { SUPPORT: 30, BOTTOM: 5 } });
    expect(roleOf(recommendDraft([p], draft([ally('P')]), catalog), 'P')).toBe('SUPPORT');
    const q = friend('Q', [], [['Jinx', 0.6], ['Thresh', 0.6]]);
    expect(roleOf(recommendDraft([q], draft([ally('Q', 'Jinx')]), catalog), 'Q')).toBe('BOTTOM');
  });

  it('a locked flex champion of a friend takes the role the friend prefers', () => {
    const p = friend('P', ['SUPPORT', 'TOP'], [['Sett', 0.8]]);
    const res = recommendDraft([p], draft([ally('P', 'Sett', true)]), catalog);
    expect(res.players[0].role).toBe('SUPPORT');
  });
});

// ----------------------------------------------------------------------------- exclusions

describe('exclusions', () => {
  it('never recommends banned, enemy or ally (locked or hovered) champions', () => {
    const theo = friend('Theo', ['MID'], [...MID_POOL, ['Zed', 0.9], ['Lux', 0.9], ['Yasuo', 0.9], ['Viktor', 0.8]]);
    const sam = friend('Sam', ['SUPPORT', 'MID'], [['Lux', 0.9], ['Thresh', 0.8]]);
    const d = draft([ally('Theo'), ally('Sam', 'Lux'), ally(null, 'Orianna', false)], [foe('Zed'), foe('Malphite')], ['Yasuo', 'Ahri']);
    const res = recommendDraft([theo, sam], d, catalog);
    const theoIds = ids(res, 'Theo');
    for (const cid of ['Zed', 'Lux', 'Yasuo', 'Ahri', 'Orianna', 'Malphite']) expect(theoIds).not.toContain(cid);
    expect(theoIds).toContain('Syndra');
    // Sam keeps the champion he hovers
    expect(ids(res, 'Sam')).toContain('Lux');
    const taken = new Set(['Zed', 'Lux', 'Yasuo', 'Ahri', 'Orianna', 'Malphite']);
    for (const b of res.bans) expect(taken.has(b.champion_id)).toBe(false);
  });

  it('avoided champions are not proposed', () => {
    const theo = friend('Theo', ['MID'], MID_POOL);
    theo.preferences.avoided_champions = ['Syndra'];
    expect(ids(recommendDraft([theo], draft([ally('Theo')]), catalog), 'Theo')).not.toContain('Syndra');
  });
});

// ----------------------------------------------------------------------------- counters

describe('counter-awareness', () => {
  it('a champion that wins the meta duel against the enemy laner rises, with a reason', () => {
    const theo = friend('Theo', ['MID'], MID_POOL);
    const d = draft([ally('Theo')], [foe('Zed', 'MID')]);
    const meta = neutralMeta();
    const base = recommendDraft([theo], d, catalog, { meta });
    const before = ids(base, 'Theo');
    const target = before.filter((c) => MID_POOL.some(([x]) => x === c)).slice(-1)[0];
    setDuel(meta, 'MID', target, 'Zed', 3000, 1800);
    const res = recommendDraft([theo], d, catalog, { meta });
    const after = ids(res, 'Theo');
    expect(after.indexOf(target)).toBeLessThan(before.indexOf(target));
    expect(after[0]).toBe(target);
    expect(pickOf(res, 'Theo', target)!.score).toBeGreaterThan(pickOf(base, 'Theo', target)!.score);
    expect(pickOf(res, 'Theo', target)!.reasons.some((r) => r.startsWith('Bon contre Zed (duel favorable sur ce patch'))).toBe(true);
  });

  it('a losing meta duel pushes a champion down and is flagged', () => {
    const theo = friend('Theo', ['MID'], MID_POOL);
    const d = draft([ally('Theo')], [foe('Zed')]); // Zed's role guessed (MID)
    const meta = neutralMeta();
    const before = ids(recommendDraft([theo], d, catalog, { meta }), 'Theo');
    setDuel(meta, 'MID', before[0], 'Zed', 3000, 1200);
    const res = recommendDraft([theo], d, catalog, { meta });
    expect(ids(res, 'Theo').indexOf(before[0])).toBeGreaterThan(0);
    expect(pickOf(res, 'Theo', before[0])!.reasons.some((r) => r.startsWith('Duel difficile contre Zed'))).toBe(true);
  });

  it("the player's own lane history against that opponent counts (without meta)", () => {
    const d = draft([ally('Theo')], [foe('Zed', 'MID')]);
    const plain = friend('Theo', ['MID'], MID_POOL);
    const before = ids(recommendDraft([plain], d, catalog), 'Theo');
    const target = before[before.length - 1];
    const hist = friend('Theo', ['MID'], MID_POOL, {
      lane_history: [{ champion_id: target, opponent_id: 'Zed', role: 'MID', games: 6, wins: 6 }],
    });
    const res = recommendDraft([hist], d, catalog);
    expect(ids(res, 'Theo').indexOf(target)).toBeLessThanOrEqual(before.indexOf(target));
    expect(pickOf(res, 'Theo', target)!.score).toBeGreaterThan(pickOf(recommendDraft([plain], d, catalog), 'Theo', target)!.score);
    expect(pickOf(res, 'Theo', target)!.reasons).toContain('Tu gagnes souvent ce duel contre Zed (6 victoires sur 6)');
  });

  it('a strong counter outside the pool may come last as a discovery', () => {
    const theo = friend('Theo', ['MID'], MID_POOL);
    const meta = neutralMeta();
    setDuel(meta, 'MID', 'Kassadin', 'Zed', 4000, 2600);
    setStat(meta, 'Kassadin', 'MID', [1200, 690]);
    const res = recommendDraft([theo], draft([ally('Theo')], [foe('Zed', 'MID')]), catalog, { meta });
    const picks = res.players[0].picks;
    expect(picks[picks.length - 1].champion_id).toBe('Kassadin');
    expect(picks[picks.length - 1].comfort).toBe(0);
    expect(picks[picks.length - 1].reasons.some((r) => r.startsWith('Peu joué'))).toBe(true);
    expect(picks.slice(0, -1).every((p) => p.comfort >= 0.15)).toBe(true);
    // no such pick without evidence
    const plain = recommendDraft([theo], draft([ally('Theo')], [foe('Zed', 'MID')]), catalog);
    expect(plain.players[0].picks.every((p) => p.comfort >= 0.15)).toBe(true);
  });
});

// ----------------------------------------------------------------------------- synergy

describe('synergy with locked allies', () => {
  const top = (): PlayerInput => friend('Lucas', ['TOP'], [['Darius', 0.7], ['Malphite', 0.7]]);

  it('completes a lineup without frontline nor magic damage', () => {
    const solo = recommendDraft([top()], draft([ally('Lucas')]), catalog);
    const d = draft([ally('Lucas'), ally(null, 'Khazix', true), ally(null, 'Talon', true), ally(null, 'Draven', true)]);
    const res = recommendDraft([top()], d, catalog);
    const gap = (a: DraftAdvice): number => pickOf(a, 'Lucas', 'Malphite')!.score - pickOf(a, 'Lucas', 'Darius')!.score;
    expect(gap(res)).toBeGreaterThan(gap(solo));
    expect(ids(res, 'Lucas')[0]).toBe('Malphite');
    const reasons = pickOf(res, 'Lucas', 'Malphite')!.reasons;
    expect(reasons.some((r) => r === 'Complète la frontline' || r === 'Apporte les dégâts magiques qui manquent')).toBe(true);
  });

  it('a duo that wins together with a locked friend rises (duo history)', () => {
    const ines = friend('Ines', ['BOTTOM'], [['Jinx', 0.9]], { puuid: 'p-ines' });
    const plain = friend('Theo', ['MID'], MID_POOL, { puuid: 'p-theo' });
    const d = draft([ally('Theo'), ally('Ines', 'Jinx', true)]);
    const before = ids(recommendDraft([plain, ines], d, catalog), 'Theo');
    const target = before[before.length - 1];
    const duo = friend('Theo', ['MID'], MID_POOL, {
      puuid: 'p-theo',
      allies: [{ puuid: 'p-ines', games: 12, wins: 10, pairs: [{ champion_id: target, ally_champion_id: 'Jinx', games: 12, wins: 10 }] }],
    });
    const res = recommendDraft([duo, ines], d, catalog);
    expect(ids(res, 'Theo').indexOf(target)).toBeLessThan(before.indexOf(target));
    expect(pickOf(res, 'Theo', target)!.reasons).toContain('Duo qui gagne souvent avec Ines (Jinx)');
  });

  it('duos are never read from unknown teammates', () => {
    const plain = friend('Theo', ['MID'], MID_POOL, {
      puuid: 'p-theo',
      allies: [{ puuid: '', games: 12, wins: 10, pairs: [{ champion_id: 'Viktor', ally_champion_id: 'Jinx', games: 12, wins: 10 }] }],
    });
    const res = recommendDraft([plain], draft([ally('Theo'), ally(null, 'Jinx', true)]), catalog);
    expect(allStrings(res).some((s) => s.startsWith('Duo'))).toBe(false);
  });
});

// ----------------------------------------------------------------------------- bans

describe('ban advice', () => {
  it('at most 3 distinct champions, never banned, picked or hovered, each with a reason', () => {
    const players = [friend('Theo', ['MID'], MID_POOL), friend('Sam', ['SUPPORT'], [['Thresh', 0.8], ['Lulu', 0.9]])];
    const d = draft([ally('Theo', 'Ahri'), ally('Sam'), ally(null, 'Jinx', true)], [foe('Zed'), foe('Malphite')], ['Yasuo', 'Vi', 'Nocturne']);
    const res = recommendDraft(players, d, catalog, { meta: neutralMeta() });
    expect(res.bans.length).toBeGreaterThan(0);
    expect(res.bans.length).toBeLessThanOrEqual(3);
    const seen = new Set(res.bans.map((b) => b.champion_id));
    expect(seen.size).toBe(res.bans.length);
    for (const b of res.bans) {
      expect(['Yasuo', 'Vi', 'Nocturne', 'Zed', 'Malphite', 'Jinx', 'Ahri']).not.toContain(b.champion_id);
      expect(catalog.get(b.champion_id)).toBeDefined();
      expect(b.why.length).toBeGreaterThan(0);
    }
  });

  it("targets a champion that beats a friend's main on this patch", () => {
    const theo = friend('Theo', ['MID'], [['Ahri', 0.9], ['Syndra', 0.5]]);
    const meta = neutralMeta();
    setDuel(meta, 'MID', 'Fizz', 'Ahri', 3000, 1850);
    const res = recommendDraft([theo], draft([ally('Theo')]), catalog, { meta });
    const fizz = res.bans.find((b) => b.champion_id === 'Fizz');
    expect(fizz).toBeDefined();
    expect(fizz!.why).toBe("Contre Ahri de Theo : Fizz gagne 62 % de ces duels sur ce patch");
    // not when the enemy already has a mid laner
    const late = recommendDraft([theo], draft([ally('Theo')], [foe('Zed', 'MID')]), catalog, { meta });
    expect(late.bans.some((b) => b.champion_id === 'Fizz')).toBe(false);
  });

  it('meta presence counts: a heavily banned, winning champion is suggested', () => {
    const meta = neutralMeta();
    setStat(meta, 'Kayn', 'JUNGLE', [2500, 1450]);
    meta.bans.Kayn = 2500;
    const res = recommendDraft([friend('Theo', ['MID'], MID_POOL)], draft([ally('Theo')]), catalog, { meta });
    const kayn = res.bans.find((b) => b.champion_id === 'Kayn');
    expect(kayn).toBeDefined();
    expect(kayn!.why).toContain('sur ce patch');
  });

  it("never proposes to ban a friend's own main champion", () => {
    const meta = neutralMeta();
    setStat(meta, 'Ahri', 'MID', [2500, 1450]);
    meta.bans.Ahri = 3000;
    const res = recommendDraft([friend('Theo', ['MID'], MID_POOL)], draft([ally('Theo')]), catalog, { meta });
    expect(res.bans.some((b) => b.champion_id === 'Ahri')).toBe(false);
  });
});

// ----------------------------------------------------------------------------- enemy analysis

describe('enemy analysis', () => {
  const theo = (): PlayerInput => friend('Theo', ['MID'], MID_POOL);

  it('1 pick: few certainties', () => {
    const res = recommendDraft([theo()], draft([ally('Theo')], [foe('Zed')]), catalog);
    const e = res.enemy!;
    expect(e.identity).toContain('Un seul champion adverse connu : Zed');
    expect(e.themes).toEqual([]);
    expect(e.weaknesses.join(' ')).toContain('impossible de juger');
    expect(e.win_conditions).toHaveLength(1);
    expect(e.threats.map((t) => t.champion_id)).toEqual(['Zed']);
    expect(e.damage_profile.AD).toBeCloseTo(1, 6);
  });

  it('3 picks: tentative reading, partial-lineup wording', () => {
    const res = recommendDraft([theo()], draft([ally('Theo')], [foe('Zed'), foe('Draven'), foe('Talon')]), catalog);
    const e = res.enemy!;
    expect(e.identity).toContain('3/5 champions connus');
    expect(e.themes.length).toBeGreaterThan(0);
    expect(e.weaknesses).toContain("Dégâts 100 % physiques pour l'instant → l'armure est rentable");
    expect(e.weaknesses.some((w) => w.startsWith('Pas encore de frontline'))).toBe(true);
    expect(e.threats.length).toBeGreaterThanOrEqual(2);
    expect(e.threats.length).toBeLessThanOrEqual(3);
  });

  it('5 picks: assertive wording, threats limited to known enemies, damage profile sums to 1', () => {
    const enemy = [foe('Zed'), foe('Draven'), foe('Talon'), foe('Khazix'), foe('Caitlyn')];
    const res = recommendDraft([theo()], draft([ally('Theo')], enemy), catalog);
    const e = res.enemy!;
    expect(e.identity).not.toContain('connus');
    expect(e.weaknesses).toContain("Dégâts 100 % physiques → l'armure est rentable");
    expect(e.weaknesses).toContain('Peu de frontline : leurs carries sont exposés');
    expect(e.weaknesses).toContain('Aucun engage fiable : ils auront du mal à forcer les combats');
    expect(e.win_conditions.length).toBeGreaterThan(0);
    expect(e.threats.length).toBeLessThanOrEqual(4);
    for (const t of e.threats) {
      expect(enemy.map((x) => x.champion_id)).toContain(t.champion_id);
      expect(t.danger).toBeGreaterThanOrEqual(1);
      expect(t.danger).toBeLessThanOrEqual(3);
    }
    const p = e.damage_profile;
    expect((p.AD ?? 0) + (p.AP ?? 0) + (p.MIXED ?? 0)).toBeCloseTo(1, 6);
  });

  it('a strong team gets strengths (frontline, engage, mixed damage)', () => {
    const enemy = [foe('Ornn'), foe('Sejuani'), foe('Orianna'), foe('Jinx'), foe('Leona')];
    const e = recommendDraft([theo()], draft([ally('Theo')], enemy), catalog).enemy!;
    expect(e.strengths.some((s) => s.startsWith('Frontline solide'))).toBe(true);
    expect(e.strengths.some((s) => s.startsWith('Engage fiable avec'))).toBe(true);
  });
});

// ----------------------------------------------------------------------------- enemy accounts

describe('enemy accounts (game started)', () => {
  const enemy = [foe('Zed'), foe('Caitlyn'), foe('Malphite')];
  const acc = (champion_id: string, points: number | null, tier = 'GOLD', masteries?: DraftEnemyAccount['masteries']): DraftEnemyAccount => ({
    puuid: `pu-${champion_id}`,
    champion_id,
    rank: { queue: 'RANKED_SOLO_5x5', tier, division: 'II', lp: 120, wins: 10, losses: 10 },
    champion_mastery: points === null ? null : { champion_id, level: 7, points },
    ...(masteries ? { masteries } : {}),
  });
  const run = (accounts?: DraftEnemyAccount[]) =>
    recommendDraft([friend('Theo', ['MID'], MID_POOL)], draft([ally('Theo')], enemy, [], accounts), catalog).enemy!;

  it('one-tricks raise the danger and are named', () => {
    const base = run();
    const res = run([acc('Malphite', 450_000)]);
    const b = base.threats.find((t) => t.champion_id === 'Malphite');
    const t = res.threats.find((x) => x.champion_id === 'Malphite')!;
    expect(t.why).toContain('450k points de maîtrise sur Malphite (probable one-trick)');
    expect(t.danger).toBe(Math.min(3, (b?.danger ?? 1) + 1));
    expect(res.strengths).toContain('Malphite est joué par un spécialiste (450k points de maîtrise)');
    expect(res.threats[0].danger).toBeGreaterThanOrEqual(res.threats[res.threats.length - 1].danger);
  });

  it('a first-timer lowers the danger and becomes a weakness', () => {
    const base = run();
    const top = base.threats[0];
    const res = run([acc(top.champion_id, 2_000, 'GOLD', [{ champion_id: 'Yasuo', level: 7, points: 300_000 }])]);
    const t = res.threats.find((x) => x.champion_id === top.champion_id)!;
    expect(t.danger).toBe(Math.max(1, top.danger - 1));
    expect(t.why).toContain('Peu joué par son joueur (2k points de maîtrise)');
    expect(res.weaknesses.some((w) => w.includes('habitué à Yasuo'))).toBe(true);
  });

  it('high ranks raise the danger, without accounts nothing changes', () => {
    const base = run();
    const low = base.threats.find((t) => t.danger < 3);
    if (low) {
      const res = run([acc(low.champion_id, null, 'GRANDMASTER')]);
      const t = res.threats.find((x) => x.champion_id === low.champion_id)!;
      expect(t.danger).toBe(low.danger + 1);
      expect(t.why).toContain('Joueur Grand Maître (120 LP)');
    }
    expect(JSON.stringify(run([]))).toBe(JSON.stringify(base));
    // mastery from the masteries list when champion_mastery is missing
    const viaList = run([{ puuid: 'x', champion_id: 'Zed', masteries: [{ champion_id: 'Zed', level: 7, points: 250_000 }] }]);
    expect(viaList.threats.find((t) => t.champion_id === 'Zed')!.why).toContain('one-trick');
  });
});

// ----------------------------------------------------------------------------- text, determinism, performance

/** Every champion × every role + dense matchups. */
function fullMeta(): MetaStats {
  const meta = neutralMeta(20000);
  let seed = 11;
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
    const list = catalog.all().filter((c) => c.roles.includes(r)).map((c) => c.id);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const g = 10 + Math.floor(rnd() * 500);
        setDuel(meta, r, list[i], list[j], g, Math.floor(g * (0.4 + 0.2 * rnd())));
      }
    }
  }
  return meta;
}

function fullPlayers(): PlayerInput[] {
  const all = catalog.all();
  const players: PlayerInput[] = ROLES.map((role, i) => {
    const main = all.filter((c) => c.roles.includes(role));
    const list = [...main, ...all.filter((c) => !c.roles.includes(role))].slice(0, 40).map((c) => c.id);
    const recent = list.slice(0, 20).map((cid, k) => ({
      champion_id: cid,
      games: 1 + (k % 6),
      wins: k % 4,
      kills: 5,
      deaths: 1 + (k % 5),
      assists: 6,
      last_played: NOW - k * DAY,
    }));
    const manual = list.slice(20).map((cid, k) => ({ champion_id: cid, comfort: 0.3 + (k % 5) * 0.1 }));
    const preferences = { roles: [role], wanted_archetypes: [], wanted_champions: [], avoided_champions: [] };
    return {
      player_id: `p${i}`,
      name: `P${i}`,
      puuid: `puuid-${i}`,
      preferences,
      role_games: { [role]: 20 },
      pool: computePool([], recent, manual, preferences, catalog),
      lane_history: list.slice(0, 15).map((cid, k) => ({ champion_id: cid, opponent_id: all[(k * 7) % all.length].id, role, games: 1 + (k % 3), wins: k % 2 })),
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

describe('text, determinism and performance', () => {
  const meta = fullMeta();
  const players = fullPlayers();
  const d = draft(
    players.map((p, i) => ally(p.player_id, i === 3 ? players[3].pool[0].champion_id : null, i === 3)),
    [foe('Zed'), foe('Malphite'), foe('Jinx', 'BOTTOM'), foe('Thresh')],
    ['Yasuo', 'Vi', 'Kayn', 'Fizz'],
    [{ puuid: 'e1', champion_id: 'Zed', champion_mastery: { champion_id: 'Zed', level: 7, points: 400_000 } }],
  );

  it('is deterministic (same input, players given in another order)', () => {
    const a = recommendDraft(players, d, catalog, { meta });
    const b = recommendDraft(players, d, catalog, { meta });
    const c = recommendDraft([...players].reverse(), d, catalog, { meta });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
  });

  it('every sentence is elided (no "de A..." / "que E...")', () => {
    const res = recommendDraft(players, d, catalog, { meta });
    const bad = /(?<![\p{L}\p{N}_])([DdLl]e|[Ll]a|[Qq]ue|[Jj]usque) (?=[AEIOUYÉÈÊÂÎÔ])/u;
    for (const s of allStrings(res)) expect(bad.test(s)).toBe(false);
    // the hover-free slot of P3 is locked, every other friend gets advice in their own role
    expect(res.players).toHaveLength(5);
    for (const p of res.players) {
      if (p.player_id === 'p3') expect(p.picks).toEqual([]);
      else expect(p.picks.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('5 friends, 40-champion pools, full meta, history and allies: under 300 ms', () => {
    recommendDraft(players, d, catalog, { meta }); // warm-up (JIT, catalog adaptation)
    const t0 = performance.now();
    const res = recommendDraft(players, d, catalog, { meta });
    const ms = performance.now() - t0;
    expect(res.bans.length).toBe(3);
    expect(res.enemy).not.toBeNull();
    expect(ms).toBeLessThan(300);
  });
});
