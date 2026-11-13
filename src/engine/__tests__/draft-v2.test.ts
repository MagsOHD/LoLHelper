// Live draft v2: enemy information during the draft (predictions, blind vs counter picks, pick order,
// enemy player insights, slot inference, matchup plan attention points).
import { describe, expect, it } from 'vitest';
import type {
  DraftAdvice,
  DraftAllySlot,
  DraftEnemySlot,
  DraftInput,
  EnemyPlayerProfile,
  GamesWins,
  MetaStats,
  Pick,
  PlayerInput,
  PlaystyleStats,
  Role,
} from '../../api/types';
import { buildCatalog, buildMatchupPlan, computePool, recommendDraft } from '..';

const catalog = buildCatalog([], 'offline');
const ROLES: Role[] = ['TOP', 'JUNGLE', 'MID', 'BOTTOM', 'SUPPORT'];

function friend(id: string, roles: Role[], pool: [string, number][], extra: Partial<PlayerInput> = {}): PlayerInput {
  const preferences = { roles, wanted_archetypes: [], wanted_champions: [], avoided_champions: [] };
  const manual = pool.map(([champion_id, comfort]) => ({ champion_id, comfort }));
  return { player_id: id, name: id, preferences, role_games: {}, pool: computePool([], [], manual, preferences, catalog), ...extra };
}
const ally = (player_id: string | null, champion_id: string | null = null, locked = false, role: Role | null = null): DraftAllySlot => ({
  player_id,
  champion_id,
  locked,
  role,
});
const foe = (champion_id: string | null, role: Role | null = null, puuid?: string): DraftEnemySlot => ({
  champion_id,
  role,
  locked: !!champion_id,
  ...(puuid ? { puuid } : {}),
});
const draft = (a: DraftAllySlot[], e: DraftEnemySlot[] = [], bans: string[] = [], extra: Partial<DraftInput> = {}): DraftInput => ({
  ally: a,
  enemy: e,
  bans,
  ...extra,
});

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

const STYLE0: PlaystyleStats = {
  games: 10,
  wins: 5,
  kills: 4,
  deaths: 5,
  assists: 6,
  cs_per_min: 6.5,
  vision_per_min: 0.9,
  damage_per_min: 600,
  kill_participation: 0.5,
  solo_kills: 0.5,
  first_blood_rate: 0.2,
  early_lead: null,
  turret_takedowns: 1,
  avg_game_minutes: 28,
};
const style = (s: Partial<PlaystyleStats> = {}): PlaystyleStats => ({ ...STYLE0, ...s });

function profile(puuid: string, role: Role, champs: [string, number, number?][], extra: Partial<EnemyPlayerProfile> = {}): EnemyPlayerProfile {
  // champs: [champion, recent games, mastery points]
  const games = Math.max(10, champs.reduce((s, [, g]) => s + g, 0));
  return {
    puuid,
    source: 'scouting',
    masteries: champs.filter(([, , p]) => p).map(([champion_id, , points]) => ({ champion_id, level: 7, points: points! })),
    recent: {
      games,
      roles: { [role]: games },
      champions: champs
        .filter(([, g]) => g > 0)
        .map(([champion_id, g]) => ({ champion_id, games: g, wins: Math.floor(g / 2), kills: 5, deaths: 5, assists: 5, role })),
    },
    style: null,
    fetched_at: '2026-11-13T10:00:00Z',
    ...extra,
  };
}

const ZED_OT = (): EnemyPlayerProfile =>
  profile('p-zed', 'MID', [
    ['Zed', 7, 412_000],
    ['Talon', 2, 40_000],
  ]);

const MID_POOL: [string, number][] = [
  ['Ahri', 0.8],
  ['Syndra', 0.8],
  ['Orianna', 0.8],
  ['Viktor', 0.8],
];
const json = (x: unknown): string => JSON.stringify(x);
const pickOf = (adv: DraftAdvice, pid: string, cid: string) =>
  adv.players.find((p) => p.player_id === pid)!.picks.find((p) => p.champion_id === cid);
const pred = (adv: DraftAdvice, role: Role) => adv.predictions.find((p) => p.role === role);

function allStrings(x: unknown, out: string[] = []): string[] {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) x.forEach((v) => allStrings(v, out));
  else if (x && typeof x === 'object') Object.values(x).forEach((v) => allStrings(v, out));
  return out;
}

// ----------------------------------------------------------------------------- invariance

describe('v2 is off without the new data', () => {
  const players = [friend('Theo', ['MID'], MID_POOL), friend('Sam', ['SUPPORT'], [['Thresh', 0.8], ['Lulu', 0.9]])];
  const base = draft([ally('Theo'), ally('Sam'), ally(null, 'Jinx', true)], [foe('Zed'), foe('Malphite')], ['Yasuo']);

  it('side null, empty profiles and slot puuids without profile change nothing', () => {
    const meta = neutralMeta();
    const ref = recommendDraft(players, base, catalog, { meta });
    expect(ref.predictions).toEqual([]);
    expect(ref.pick_order).toEqual([]);
    expect(ref.enemy_players).toEqual([]);
    const same = recommendDraft(players, { ...base, side: null, enemy_profiles: [] }, catalog, { meta });
    expect(json(same)).toBe(json(ref));
    const withPuuid = { ...base, enemy: [foe('Zed', null, 'secret-puuid'), foe('Malphite')] };
    expect(json(recommendDraft(players, withPuuid, catalog, { meta }))).toBe(json(ref));
  });

  it('matchup plan without (or with empty) enemy profiles is unchanged and has no new keys', () => {
    const ally: Pick[] = [{ role: 'MID', champion_id: 'Ahri' }];
    const enemy: Pick[] = [{ role: 'MID', champion_id: 'Zed' }];
    const plan = buildMatchupPlan(ally, enemy, catalog);
    expect('enemy_players' in plan).toBe(false);
    expect('attention' in plan).toBe(false);
    expect(json(buildMatchupPlan(ally, enemy, catalog, { enemy_profiles: [] }))).toBe(json(plan));
  });

  it('never outputs an enemy identity that did not come in through enemy_profiles', () => {
    const d = draft([ally('Theo')], [foe('Zed', 'MID', 'secret-1'), foe(null, null, 'secret-2')], [], {
      phase: 'pick',
      side: 'blue',
      enemy_profiles: [profile('p-known', 'JUNGLE', [['LeeSin', 5, 150_000]])],
    });
    const res = recommendDraft([friend('Theo', ['MID'], MID_POOL)], d, catalog);
    const text = json(res);
    expect(text).not.toContain('secret');
    expect(res.enemy_players.map((p) => p.puuid)).toEqual(['p-known']);
  });
});

// ----------------------------------------------------------------------------- predictions

describe('predictions of enemy picks', () => {
  const theo = (): PlayerInput => friend('Theo', ['MID'], MID_POOL);

  it('without collected meta, no role prediction is shown (curated roles alone are not evidence)', () => {
    const d = draft([ally('Theo'), ally(null, 'Jinx', true)], [foe('Zed', 'MID')], ['Malphite', 'LeeSin'], { phase: 'pick' });
    expect(recommendDraft([theo()], d, catalog).predictions).toEqual([]);
  });

  it('with meta: open roles only, ≤ 5 candidates playing the role, never banned / picked', () => {
    const d = draft([ally('Theo'), ally(null, 'Jinx', true)], [foe('Zed', 'MID')], ['Malphite', 'LeeSin'], { phase: 'pick' });
    const res = recommendDraft([theo()], d, catalog, { meta: neutralMeta() });
    expect(res.predictions.map((p) => p.role)).toEqual(['TOP', 'JUNGLE', 'BOTTOM', 'SUPPORT']);
    for (const p of res.predictions) {
      expect(p.candidates.length).toBeGreaterThan(0);
      expect(p.candidates.length).toBeLessThanOrEqual(5);
      for (let i = 0; i < p.candidates.length; i++) {
        const c = p.candidates[i];
        expect(catalog.get(c.champion_id)!.roles).toContain(p.role);
        expect(['Malphite', 'LeeSin', 'Zed', 'Jinx']).not.toContain(c.champion_id);
        expect(c.likelihood).toBeGreaterThan(0);
        expect(c.likelihood).toBeLessThanOrEqual(1);
        expect(c.why.length).toBeGreaterThan(0);
        expect(c.player_puuid).toBeUndefined();
        if (i) expect(p.candidates[i - 1].likelihood).toBeGreaterThanOrEqual(c.likelihood);
      }
    }
  });

  it('meta pick rate in the role drives the candidates, cited in the reason', () => {
    const meta = neutralMeta();
    setStat(meta, 'Kayn', 'JUNGLE', [1500, 760]);
    const res = recommendDraft([theo()], draft([ally('Theo')], [], [], { phase: 'ban' }), catalog, { meta });
    const jg = pred(res, 'JUNGLE')!.candidates[0];
    expect(jg.champion_id).toBe('Kayn');
    expect(jg.why).toBe('Très joué en Jungle sur ce patch (30 % des parties)');
  });

  it('counters to our locked laner rise, with the duel in the reason', () => {
    const meta = neutralMeta();
    setDuel(meta, 'MID', 'Fizz', 'Ahri', 3000, 1860);
    const before = recommendDraft([], draft([ally(null)], [], [], { phase: 'pick' }), catalog, { meta });
    const after = recommendDraft([], draft([ally(null, 'Ahri', true, 'MID')], [], [], { phase: 'pick' }), catalog, { meta });
    const lb = pred(before, 'MID')!.candidates.find((c) => c.champion_id === 'Fizz')?.likelihood ?? 0;
    const fizz = pred(after, 'MID')!.candidates[0];
    expect(fizz.champion_id).toBe('Fizz');
    expect(fizz.likelihood).toBeGreaterThan(lb);
    expect(fizz.why).toContain('bat Ahri dans 62 % des duels sur ce patch');
  });

  it('a scouted player whose main role is open predicts their own pool (player_puuid)', () => {
    const d = draft([ally('Theo')], [], [], { phase: 'pick', enemy_profiles: [ZED_OT()] });
    const res = recommendDraft([theo()], d, catalog);
    const mid = pred(res, 'MID')!.candidates;
    expect(mid[0]).toMatchObject({ champion_id: 'Zed', player_puuid: 'p-zed' });
    expect(mid[0].why).toBe('Champion principal de ce joueur (7 parties sur 10 récentes, 412k points)');
    expect(mid[1]).toMatchObject({ champion_id: 'Talon', player_puuid: 'p-zed' });
    expect(mid[0].likelihood).toBeGreaterThan(0.5);
    // other roles stay generic
    for (const p of res.predictions) if (p.role !== 'MID') for (const c of p.candidates) expect(c.player_puuid).toBeUndefined();
    // banned: their next champion leads
    const banned = recommendDraft([theo()], { ...d, bans: ['Zed'] }, catalog);
    expect(pred(banned, 'MID')!.candidates[0].champion_id).toBe('Talon');
  });

  it('two scouted players on the same main role: the best total role fit wins', () => {
    const a = profile('p-a', 'MID', [['Zed', 6, 100_000]]);
    const b: EnemyPlayerProfile = { ...profile('p-b', 'MID', [['Sylas', 4, 80_000]]), recent: { games: 10, roles: { MID: 6, JUNGLE: 4 }, champions: [{ champion_id: 'Sylas', games: 4, wins: 2, kills: 5, deaths: 5, assists: 5, role: 'JUNGLE' }] } };
    const res = recommendDraft([], draft([ally(null)], [], [], { phase: 'pick', enemy_profiles: [a, b] }), catalog);
    expect(pred(res, 'MID')!.candidates[0].player_puuid).toBe('p-a');
    expect(pred(res, 'JUNGLE')!.candidates[0]).toMatchObject({ champion_id: 'Sylas', player_puuid: 'p-b' });
  });

  it('no prediction once the game has started', () => {
    const res = recommendDraft([theo()], draft([ally('Theo')], [], [], { phase: 'in_game' }), catalog);
    expect(res.predictions).toEqual([]);
    expect(res.pick_order).toEqual([]);
  });
});

// ----------------------------------------------------------------------------- blind vs counter

describe('blind vs counter pick advice', () => {
  const blindMeta = (): MetaStats => {
    const meta = neutralMeta();
    // the enemy mid is very likely Fizz or Katarina; Syndra loses to both, Orianna beats both
    setStat(meta, 'Fizz', 'MID', [2500, 1260]);
    setStat(meta, 'Katarina', 'MID', [2000, 1000]);
    for (const e of ['Fizz', 'Katarina']) {
      setDuel(meta, 'MID', 'Syndra', e, 3000, 1170);
      setDuel(meta, 'MID', 'Orianna', e, 3000, 1800);
    }
    return meta;
  };

  it('blind: champions losing to the likely enemy picks drop, those beating them rise, with reasons', () => {
    const meta = blindMeta();
    const theo = friend('Theo', ['MID'], MID_POOL);
    const v1 = recommendDraft([theo], draft([ally('Theo')]), catalog, { meta });
    const v2 = recommendDraft([theo], draft([ally('Theo')], [], [], { phase: 'pick' }), catalog, { meta });
    expect(pickOf(v2, 'Theo', 'Syndra')!.score).toBeLessThan(pickOf(v1, 'Theo', 'Syndra')!.score);
    expect(pickOf(v2, 'Theo', 'Orianna')!.score).toBeGreaterThan(pickOf(v1, 'Theo', 'Orianna')!.score);
    expect(v2.players[0].picks[0].champion_id).toBe('Orianna');
    expect(pickOf(v2, 'Theo', 'Syndra')!.reasons).toContain('Risqué en blind : perd contre Fizz (39 % sur ce patch)');
    expect(pickOf(v2, 'Theo', 'Orianna')!.reasons).toContain('Bon blind pick : favorable contre Fizz et Katarina');
    expect(allStrings(v1).some((s) => s.includes('blind'))).toBe(false);
  });

  it('blind: flexible champions get a small bonus and a reason', () => {
    const p = friend('P', ['MID'], [['Sylas', 0.7], ['Syndra', 0.7]]);
    const v1 = recommendDraft([p], draft([ally('P')]), catalog);
    const v2 = recommendDraft([p], draft([ally('P')], [], [], { side: 'red' }), catalog);
    const gain = (cid: string): number => pickOf(v2, 'P', cid)!.score - pickOf(v1, 'P', cid)!.score;
    expect(gain('Sylas')).toBeCloseTo(1.5, 1);
    expect(gain('Syndra')).toBeCloseTo(0, 6);
    expect(pickOf(v2, 'P', 'Sylas')!.reasons).toContain('Pick flexible (Mid/Jungle) : cache votre rôle');
  });

  it('counter pick: the lane duel weighs 1.5× once the enemy laner is shown, nothing else moves', () => {
    const meta = neutralMeta();
    setDuel(meta, 'MID', 'Viktor', 'Zed', 3000, 1800);
    const theo = friend('Theo', ['MID'], MID_POOL);
    const d = draft([ally('Theo')], [foe('Zed', 'MID')]);
    const v1 = recommendDraft([theo], d, catalog, { meta });
    const v2 = recommendDraft([theo], { ...d, phase: 'pick' }, catalog, { meta });
    const vik1 = pickOf(v1, 'Theo', 'Viktor')!.score;
    const vik2 = pickOf(v2, 'Theo', 'Viktor')!.score;
    // DRAFT_W_LANE (0.08) × edge 1 × confidence 1 = +8 points in v1, +4 more in v2
    expect(vik2 - vik1).toBeCloseTo(4, 1);
    expect(pickOf(v2, 'Theo', 'Ahri')!.score).toBe(pickOf(v1, 'Theo', 'Ahri')!.score);
  });
});

// ----------------------------------------------------------------------------- pick order

describe('pick order', () => {
  const theo = (): PlayerInput => friend('Theo', ['MID'], MID_POOL);
  const ines = (): PlayerInput => friend('Ines', ['BOTTOM'], [['Jinx', 0.9]]);

  it('the most counter-sensitive friend should pick last: swap suggested with the slot holding that turn', () => {
    const d = draft([ally('Theo'), ally(null), ally(null), ally(null), ally(null)], [], [], { side: 'blue', phase: 'planning' });
    const res = recommendDraft([theo()], d, catalog);
    expect(res.pick_order).toContain("Theo (mid) devrait picker en B5 (plus qu'un pick adverse après) : échangez avec le coéquipier en B5.");
  });

  it('already last on red side: confirmed', () => {
    const d = draft([ally(null, 'Darius', true), ally(null, 'Vi', true), ally(null), ally(null), ally('Theo')], [], [], { side: 'red', phase: 'pick' });
    const res = recommendDraft([theo()], d, catalog);
    expect(res.pick_order).toEqual(['Bon ordre : Theo (mid) picke en R5 (aucun pick adverse après) et pourra contrer son vis-à-vis.']);
  });

  it('a narrow pool picks early (before the second ban phase), the mid later', () => {
    const d = draft([ally('Theo'), ally(null, 'Darius', true), ally(null, 'Vi', true), ally('Ines')], [], [], { side: 'blue', phase: 'pick' });
    const res = recommendDraft([theo(), ines()], d, catalog);
    expect(res.pick_order[0]).toBe("Theo (mid) devrait picker en B4 (plus qu'un pick adverse après) : échangez avec Ines (ADC).");
    expect(res.pick_order).toContain('Ines (ADC) dépend de Jinx : à sécuriser tôt.');
    // without the swap Ines would pick B4, after the second ban phase
    const late = draft([ally(null, 'Darius', true), ally(null, 'Vi', true), ally(null, 'Ahri', true), ally('Ines')], [], [], { side: 'blue', phase: 'pick' });
    expect(recommendDraft([ines()], late, catalog).pick_order).toEqual([
      'Ines (ADC) dépend de Jinx : à sécuriser tôt (en B4, son tour vient après la 2e phase de bans).',
    ]);
  });

  it('a contested top recommendation should be taken early', () => {
    const meta = neutralMeta();
    setStat(meta, 'Ahri', 'MID', [600, 330]);
    meta.bans.Ahri = 400;
    const d = draft([ally(null), ally(null), ally(null), ally(null), ally('Theo')], [], [], { side: 'blue', phase: 'pick' });
    const res = recommendDraft([theo()], d, catalog, { meta });
    expect(res.players[0].picks[0].champion_id).toBe('Ahri');
    expect(res.pick_order).toContain('Ahri est très disputé sur ce patch (20 % de présence) : Theo (mid) devrait le prendre tôt.');
  });

  it('nothing without side, in finalization, or when the enemy laner is already shown', () => {
    const slots = [ally('Theo'), ally(null), ally(null), ally(null), ally(null)];
    expect(recommendDraft([theo()], draft(slots, [], [], { phase: 'pick' }), catalog).pick_order).toEqual([]);
    expect(recommendDraft([theo()], draft(slots, [], [], { phase: 'finalization', side: 'blue' }), catalog).pick_order).toEqual([]);
    const shown = recommendDraft([theo()], draft(slots, [foe('Zed', 'MID')], [], { phase: 'pick', side: 'blue' }), catalog);
    expect(shown.pick_order.some((s) => s.startsWith('Theo (mid) devrait'))).toBe(false);
  });
});

// ----------------------------------------------------------------------------- insights

describe('enemy player insights', () => {
  const run = (profiles: EnemyPlayerProfile[], enemy: DraftEnemySlot[] = [], bans: string[] = []) =>
    recommendDraft([friend('Theo', ['MID'], MID_POOL)], draft([ally('Theo')], enemy, bans, { phase: 'pick', enemy_profiles: profiles }), catalog);

  it('style tags follow the documented thresholds and cite the numbers', () => {
    const p = profile('p1', 'JUNGLE', [['LeeSin', 5, 100_000]], {
      style: style({ first_blood_rate: 0.62, kills: 8, deaths: 6, solo_kills: 1.5, cs_per_min: 6.5, vision_per_min: 0.5, kill_participation: 0.65, turret_takedowns: 2.5, damage_per_min: 900 }),
    });
    const tags = run([p]).enemy_players[0].style_tags;
    expect(tags).toEqual([
      'Très agressif (14 kills + morts par partie)',
      'Cherche le premier sang (62 % des parties)',
      'Gagne ses duels (1,5 solo kills par partie)',
      'Farm avant tout (6,5 cs/min)',
      'Vision faible (0,5 par minute)',
    ]);
    const below = profile('p2', 'JUNGLE', [['LeeSin', 5, 100_000]], {
      style: style({ first_blood_rate: 0.39, kills: 7.9, deaths: 6, solo_kills: 1.49, cs_per_min: 6.4, vision_per_min: 0.51, kill_participation: 0.64 }),
    });
    expect(run([below]).enemy_players[0].style_tags).toEqual([]);
    // role-dependent thresholds: 6,5 cs/min is not "farm" for a mid laner, low vision differs for supports
    const mid = profile('p3', 'MID', [['Zed', 5, 100_000]], { style: style({ cs_per_min: 7.9, vision_per_min: 0.9 }) });
    expect(run([mid]).enemy_players[0].style_tags).toEqual([]);
    const sup = profile('p4', 'SUPPORT', [['Thresh', 5, 100_000]], { style: style({ vision_per_min: 1.2, cs_per_min: 1 }) });
    expect(run([sup]).enemy_players[0].style_tags).toEqual(['Vision faible (1,2 par minute)']);
    // too few games: no tag
    expect(run([{ ...p, style: style({ games: 2, first_blood_rate: 0.9 }) }]).enemy_players[0].style_tags).toEqual([]);
  });

  it('lane lead: a 0..1 value is a share of games ahead, otherwise gold + XP', () => {
    const rate = profile('p1', 'TOP', [['Darius', 5, 100_000]], { style: style({ early_lead: 0.7 }) });
    expect(run([rate]).enemy_players[0].style_tags).toContain('Gagne souvent sa lane (en avance dans 70 % des parties)');
    const abs = profile('p2', 'TOP', [['Darius', 5, 100_000]], { style: style({ early_lead: -650 }) });
    expect(run([abs]).enemy_players[0].style_tags).toContain('Perd souvent sa lane (-650 or et XP en moyenne)');
  });

  it('one-trick by mastery (≥ 200k) or by recent share (≥ 40 %)', () => {
    const t = (p: EnemyPlayerProfile): string[] => run([p]).enemy_players[0].threats;
    expect(t(profile('a', 'MID', [['Zed', 1, 200_000]]))).toContain('One-trick Zed (200k points)');
    expect(t(profile('b', 'MID', [['Zed', 1, 199_000]]))).toEqual([]);
    expect(t(profile('c', 'MID', [['Zed', 4, 20_000], ['Ahri', 3, 20_000]]))).toContain('One-trick Zed (4 parties sur 10 récentes)');
    expect(t(profile('d', 'MID', [['Zed', 3, 20_000], ['Ahri', 3, 20_000]]))).toEqual([]);
  });

  it('high rank, ranked winrate, hot streak and probable smurf are threats', () => {
    const p = profile('p1', 'MID', [['Zed', 2, 50_000]], {
      rank: { queue: 'RANKED_SOLO_5x5', tier: 'GRANDMASTER', division: 'I', lp: 512, wins: 70, losses: 40 },
      summoner_level: 48,
      style: style({ games: 10, wins: 8 }),
    });
    expect(run([p]).enemy_players[0].threats).toEqual([
      'Joueur Grand Maître (512 LP)',
      '64 % de victoires en classé (70 V / 40 D)',
      'Compte de niveau 48 déjà Grand Maître (512 LP) : probablement plus fort que son compte',
      'En forme : 8 victoires sur 10 parties récentes',
    ]);
    const cold = profile('p2', 'MID', [['Zed', 2, 50_000]], { style: style({ games: 10, wins: 2 }) });
    expect(run([cold]).enemy_players[0].attention_points).toContain('Série difficile (2 victoires sur 10) : mettez-lui la pression tôt');
  });

  it('attention points tie the advice to the measured stat', () => {
    const jg = profile('p1', 'JUNGLE', [['LeeSin', 5, 100_000]], { style: style({ first_blood_rate: 0.62, deaths: 7.5 }) });
    const ap = run([jg]).enemy_players[0].attention_points;
    expect(ap).toContain('Envahit tôt (62 % de premiers sangs) : wardez votre jungle vers 2:30 et restez groupés au niveau 1');
    expect(ap).toContain('Meurt souvent (7,5 morts par partie) : punissez ses prises de risque');
  });

  it('likely picks while their champion is unknown (bans excluded), none once it is known; one-trick ban advice', () => {
    const res = run([ZED_OT()]);
    const ins = res.enemy_players[0];
    expect(ins).toMatchObject({ puuid: 'p-zed', role: 'MID', champion_id: null, likely_picks: ['Zed', 'Talon'] });
    expect(ins.attention_points[0]).toBe('Bannissez Zed ou préparez ce matchup (412k points, 7 parties sur 10 récentes)');
    expect(res.bans[0]).toEqual({ champion_id: 'Zed', why: 'One-trick adverse (Mid) : 412k points, 7 parties sur 10 récentes' });
    const banned = run([ZED_OT()], [], ['Zed']);
    expect(banned.enemy_players[0].likely_picks).toEqual(['Talon']);
    expect(banned.bans.some((b) => b.champion_id === 'Zed')).toBe(false);
    const locked = run([ZED_OT()], [foe('Zed', 'MID', 'p-zed')]);
    expect(locked.enemy_players[0]).toMatchObject({ champion_id: 'Zed', role: 'MID', likely_picks: [] });
    expect(locked.enemy_players[0].threats[0]).toBe('One-trick Zed (412k points, 7 parties sur 10 récentes)');
  });

  it('a locked champion barely played by its player is an attention point', () => {
    const res = run([ZED_OT()], [foe('Yasuo', 'MID', 'p-zed')]);
    expect(res.enemy_players[0].attention_points).toContain(
      "Peu d'expérience sur Yasuo (aucune maîtrise notable, aucune partie récente, habitué à Zed) : punissez ses erreurs tôt",
    );
  });

  it('identities are kept verbatim while sentences are elided', () => {
    const p = profile('p1', 'MID', [['Ahri', 5, 250_000], ['Zed', 1, 30_000]], { riot_id: 'Le Ezreal#EUW' });
    const res = run([p], [foe('Ahri', 'MID', 'p1')]);
    const ins = res.enemy_players[0];
    expect(ins.riot_id).toBe('Le Ezreal#EUW');
    const bad = /(?<![\p{L}\p{N}_])([DdLl]e|[Ll]a|[Qq]ue|[Jj]usque) (?=[AEIOUYÉÈÊÂÎÔ])/u;
    for (const s of allStrings({ ...res, enemy_players: res.enemy_players.map((x) => ({ ...x, riot_id: null })) })) expect(bad.test(s)).toBe(false);
  });
});

// ----------------------------------------------------------------------------- slot inference

describe('which enemy slot a known player is on', () => {
  const run = (profiles: EnemyPlayerProfile[], enemy: DraftEnemySlot[]) =>
    recommendDraft([], draft([ally(null)], enemy, [], { phase: 'pick', enemy_profiles: profiles }), catalog, { meta: neutralMeta() });

  it('a locked champion clearly in exactly one pool links that player (and its role)', () => {
    const sup = profile('p-sup', 'SUPPORT', [['Sett', 3, 60_000], ['Thresh', 5, 90_000]]);
    const mid = profile('p-mid', 'MID', [['Ahri', 6, 100_000]]);
    const plain = recommendDraft([], draft([ally(null)], [foe('Sett')], [], { phase: 'pick' }), catalog, { meta: neutralMeta() });
    expect(plain.predictions.map((p) => p.role)).not.toContain('TOP'); // Sett guessed top without information
    const res = run([sup, mid], [foe('Sett')]);
    expect(res.enemy_players.find((p) => p.puuid === 'p-sup')).toMatchObject({ champion_id: 'Sett', role: 'SUPPORT' });
    expect(res.enemy_players.find((p) => p.puuid === 'p-mid')).toMatchObject({ champion_id: null, role: 'MID' });
    expect(res.predictions.map((p) => p.role)).toEqual(['TOP', 'JUNGLE', 'MID', 'BOTTOM']);
    expect(res.enemy!.identity).toContain('Sett');
  });

  it('ambiguous (champion in two pools, or one game only): no link', () => {
    const a = profile('p-a', 'JUNGLE', [['Viego', 3, 60_000]]);
    const b = profile('p-b', 'JUNGLE', [['Viego', 2, 0]]);
    const res = run([a, b], [foe('Viego')]);
    expect(res.enemy_players.every((p) => p.champion_id === null)).toBe(true);
    const thin = profile('p-c', 'JUNGLE', [['Viego', 1, 5_000], ['LeeSin', 5, 100_000]]);
    expect(run([thin], [foe('Viego')]).enemy_players[0].champion_id).toBeNull();
  });

  it('slot puuid and profile champion link directly', () => {
    const a = profile('p-a', 'JUNGLE', [['LeeSin', 5, 100_000]]);
    const b = { ...profile('p-b', 'MID', [['Ahri', 5, 100_000]]), champion_id: 'Zed', role: 'MID' as Role };
    const res = run([a, b], [foe('Viego', null, 'p-a'), foe('Zed')]);
    expect(res.enemy_players[0]).toMatchObject({ puuid: 'p-a', champion_id: 'Viego', role: 'JUNGLE' });
    expect(res.enemy_players[1]).toMatchObject({ puuid: 'p-b', champion_id: 'Zed', role: 'MID' });
    // a revealed player who has not picked yet: their pool fills the predictions of their role
    const open = run([a], [foe(null, 'JUNGLE', 'p-a')]);
    expect(pred(open, 'JUNGLE')!.candidates[0]).toMatchObject({ champion_id: 'LeeSin', player_puuid: 'p-a' });
  });
});

// ----------------------------------------------------------------------------- matchup plan

describe('matchup plan with enemy profiles', () => {
  const allyTeam: Pick[] = [
    { role: 'TOP', champion_id: 'Darius' },
    { role: 'JUNGLE', champion_id: 'Vi' },
    { role: 'MID', champion_id: 'Ahri' },
    { role: 'BOTTOM', champion_id: 'Jinx' },
    { role: 'SUPPORT', champion_id: 'Thresh' },
  ];
  const enemyTeam: Pick[] = [
    { role: 'TOP', champion_id: 'Fiora' },
    { role: 'JUNGLE', champion_id: 'LeeSin' },
    { role: 'MID', champion_id: 'Zed' },
    { role: 'BOTTOM', champion_id: 'Caitlyn' },
    { role: 'SUPPORT', champion_id: 'Lux' },
  ];
  const game = (p: EnemyPlayerProfile, champion_id: string, role: Role): EnemyPlayerProfile => ({ ...p, source: 'game', champion_id, role });

  it('adds one insight per profile and early / mid / late points tied to concrete enemies', () => {
    const profiles = [
      game(profile('p-lee', 'JUNGLE', [['LeeSin', 6, 150_000]], { style: style({ first_blood_rate: 0.62 }) }), 'LeeSin', 'JUNGLE'),
      game(profile('p-fio', 'TOP', [['Fiora', 5, 90_000]], { style: style({ turret_takedowns: 3.1, kill_participation: 0.28 }) }), 'Fiora', 'TOP'),
      game(profile('p-cait', 'BOTTOM', [['Caitlyn', 3, 40_000]], { style: style({ deaths: 7.5 }), riot_id: 'La Ahri#1' }), 'Caitlyn', 'BOTTOM'),
    ];
    const base = buildMatchupPlan(allyTeam, enemyTeam, catalog);
    const plan = buildMatchupPlan(allyTeam, enemyTeam, catalog, { enemy_profiles: profiles });
    expect({ ...plan, enemy_players: undefined, attention: undefined }).toEqual({ ...base, enemy_players: undefined, attention: undefined });
    expect(plan.enemy_players!.map((p) => [p.puuid, p.champion_id, p.role])).toEqual([
      ['p-lee', 'LeeSin', 'JUNGLE'],
      ['p-fio', 'Fiora', 'TOP'],
      ['p-cait', 'Caitlyn', 'BOTTOM'],
    ]);
    expect(plan.enemy_players![2].riot_id).toBe('La Ahri#1');
    expect(plan.attention).toEqual([
      { phase: 'early', text: 'Early : leur jungler (Lee Sin, 62 % de premiers sangs) envahit souvent : wardez votre jungle à 2:30.', enemy_puuid: 'p-lee' },
      {
        phase: 'early',
        text: 'Early : leur top est un spécialiste de Fiora (5 parties sur 10 récentes) : ne sous-estimez pas ses pics de puissance.',
        enemy_puuid: 'p-fio',
      },
      {
        phase: 'early',
        text: 'Early : leur jungler est un spécialiste de Lee Sin (6 parties sur 10 récentes) : ne sous-estimez pas ses pics de puissance.',
        enemy_puuid: 'p-lee',
      },
      { phase: 'mid', text: 'Mid : leur top (Fiora, 3,1 tours par partie) pousse en side : gardez de la vision sur sa lane avant chaque objectif.', enemy_puuid: 'p-fio' },
      { phase: 'late', text: 'Late : leur ADC (Caitlyn, 7,5 morts par partie) se place souvent mal : ciblez-le en premier.', enemy_puuid: 'p-cait' },
      { phase: 'late', text: 'Late : leur top (Fiora, 28 % de participation aux kills) rejoint peu les combats : forcez les objectifs quand il est en side.', enemy_puuid: 'p-fio' },
    ]);
  });

  it('profiles without champion are matched by explicit role or pool', () => {
    const p = { ...profile('p-zed', 'MID', [['Zed', 7, 412_000]]), role: 'MID' as Role };
    const q = profile('p-lux', 'SUPPORT', [['Lux', 4, 80_000]]);
    const plan = buildMatchupPlan(allyTeam, enemyTeam, catalog, { enemy_profiles: [p, q] });
    expect(plan.enemy_players!.map((x) => x.champion_id)).toEqual(['Zed', 'Lux']);
    expect(plan.enemy_players![0].threats[0]).toBe('One-trick Zed (412k points, 7 parties sur 10 récentes)');
    expect(plan.attention!.some((a) => a.text.startsWith('Early : leur mid est un spécialiste de Zed'))).toBe(true);
  });
});

// ----------------------------------------------------------------------------- determinism, performance

describe('v2 determinism and performance', () => {
  function fullMeta(): MetaStats {
    const meta = neutralMeta(20000);
    let seed = 5;
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
      const list = catalog.all().map((c) => c.id);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (rnd() < 0.5) continue;
          const g = 10 + Math.floor(rnd() * 500);
          setDuel(meta, r, list[i], list[j], g, Math.floor(g * (0.4 + 0.2 * rnd())));
        }
      }
    }
    return meta;
  }
  const all = catalog.all();
  const players: PlayerInput[] = ROLES.map((role, i) => {
    const list = [...all.filter((c) => c.roles.includes(role)), ...all].slice(0, 40).map((c) => c.id);
    return friend(`p${i}`, [role], list.map((cid, k) => [cid, 0.3 + (k % 6) * 0.1] as [string, number]), {
      lane_history: list.slice(0, 15).map((cid, k) => ({ champion_id: cid, opponent_id: all[(k * 7) % all.length].id, role, games: 1 + (k % 3), wins: k % 2 })),
    });
  });
  const profiles: EnemyPlayerProfile[] = ROLES.map((role, i) => {
    const list = all.filter((c) => c.roles.includes(role)).slice(i, i + 20);
    return profile(
      `e${i}`,
      role,
      list.map((c, k) => [c.id, k < 15 ? 1 + (k % 4) : 0, 200_000 - k * 9_000] as [string, number, number]),
      { style: style({ first_blood_rate: 0.1 * i, deaths: 4 + i, solo_kills: 0.5 * i }), rank: { queue: 'RANKED_SOLO_5x5', tier: 'DIAMOND', division: 'II', lp: 50, wins: 60, losses: 40 } },
    );
  });
  const meta = fullMeta();
  const d = draft(
    players.map((p, i) => ally(p.player_id, i === 0 ? players[0].pool[0].champion_id : null, i === 0)),
    [foe('Zed'), foe('Malphite')],
    ['Yasuo', 'Vi', 'Kayn', 'Fizz'],
    { side: 'red', phase: 'pick', enemy_profiles: profiles },
  );

  it('is deterministic and produces every v2 field', () => {
    const a = recommendDraft(players, d, catalog, { meta });
    const b = recommendDraft([...players].reverse(), d, catalog, { meta });
    expect(json(b)).toBe(json(a));
    expect(a.predictions.length).toBeGreaterThan(0);
    expect(a.enemy_players).toHaveLength(5);
    expect(a.enemy_players.map((p) => p.puuid)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4']);
  });

  it('5 scouted profiles, 5 friends with 40-champion pools and full meta: under 300 ms', () => {
    recommendDraft(players, d, catalog, { meta });
    const t0 = performance.now();
    recommendDraft(players, d, catalog, { meta });
    expect(performance.now() - t0).toBeLessThan(300);
  });
});
