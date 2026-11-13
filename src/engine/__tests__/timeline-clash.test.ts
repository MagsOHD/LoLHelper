// Enemy insights from match timelines (PlaystyleStats.timeline) and Clash declared positions.
import { describe, expect, it } from 'vitest';
import type {
  DraftAllySlot,
  DraftEnemySlot,
  DraftInput,
  EnemyPlayerProfile,
  Pick,
  PlaystyleStats,
  Role,
  TimelineStyle,
} from '../../api/types';
import { buildCatalog, buildMatchupPlan, clashRoleOf, clock, recommendDraft } from '..';

const catalog = buildCatalog([], 'offline');
const json = (x: unknown): string => JSON.stringify(x);

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
const draft = (e: DraftEnemySlot[], profiles: EnemyPlayerProfile[], extra: Partial<DraftInput> = {}): DraftInput => ({
  ally: [ally(null)],
  enemy: e,
  bans: [],
  phase: 'pick',
  enemy_profiles: profiles,
  ...extra,
});

// neutral style for every role used below (no tag of its own)
const STYLE0: PlaystyleStats = {
  games: 10,
  wins: 5,
  kills: 4,
  deaths: 5,
  assists: 6,
  cs_per_min: 6,
  vision_per_min: 0.9,
  damage_per_min: 600,
  kill_participation: 0.5,
  solo_kills: 0.5,
  first_blood_rate: 0.2,
  early_lead: null,
  turret_takedowns: 1,
  avg_game_minutes: 28,
};
const NEUTRAL_TL: TimelineStyle = {
  games: 3,
  gold_diff_10: 0,
  cs_10: 70,
  kills_before_10: 1,
  deaths_before_10: 0.7,
  first_gank_minute: null,
  first_gank_lane: null,
  first_back_minute: 5,
  wards_per_min: 0.5,
  level6_minute: null,
};
const tl = (t: Partial<TimelineStyle> = {}): TimelineStyle => ({ ...NEUTRAL_TL, ...t });
const style = (s: Partial<PlaystyleStats> = {}, t: Partial<TimelineStyle> | null = null): PlaystyleStats => ({
  ...STYLE0,
  ...s,
  ...(t ? { timeline: tl(t) } : {}),
});

function profile(puuid: string, role: Role, champs: [string, number, number?][], extra: Partial<EnemyPlayerProfile> = {}): EnemyPlayerProfile {
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

const insight = (p: EnemyPlayerProfile, enemy: DraftEnemySlot[] = []) => recommendDraft([], draft(enemy, [p]), catalog).enemy_players[0];

const GANKER_TL: Partial<TimelineStyle> = {
  first_gank_minute: 3.33,
  first_gank_lane: 'BOTTOM',
  kills_before_10: 2.3,
  level6_minute: 6.5,
  wards_per_min: 0.3,
  first_back_minute: 7.67,
};
const ganker = (extra: Partial<EnemyPlayerProfile> = {}): EnemyPlayerProfile =>
  profile('p-lee', 'JUNGLE', [['LeeSin', 2, 40_000]], { style: style({}, GANKER_TL), ...extra });

function allStrings(x: unknown, out: string[] = []): string[] {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) x.forEach((v) => allStrings(v, out));
  else if (x && typeof x === 'object') Object.values(x).forEach((v) => allStrings(v, out));
  return out;
}
const BAD_ELISION = /(?<![\p{L}\p{N}_])([DdLl]e|[Ll]a|[Qq]ue|[Jj]usque) (?=[AEIOUYÉÈÊÂÎÔ])/u;

// ----------------------------------------------------------------------------- helpers

describe('formatting helpers', () => {
  it('clock: minutes as m:ss rounded to 5 seconds', () => {
    expect(clock(3.33)).toBe('3:20');
    expect(clock(7.67)).toBe('7:40');
    expect(clock(5.83)).toBe('5:50');
    expect(clock(10)).toBe('10:00');
    expect(clock(3.37)).toBe('3:20');
  });

  it('clash positions map to roles, FILL / UNSELECTED to none', () => {
    expect(clashRoleOf('MIDDLE')).toBe('MID');
    expect(clashRoleOf('UTILITY')).toBe('SUPPORT');
    expect(clashRoleOf('BOTTOM')).toBe('BOTTOM');
    expect(clashRoleOf('FILL')).toBeNull();
    expect(clashRoleOf('UNSELECTED')).toBeNull();
    expect(clashRoleOf(null)).toBeNull();
  });
});

// ----------------------------------------------------------------------------- invariance

describe('without timeline or Clash data nothing changes', () => {
  const lee = profile('p-lee', 'JUNGLE', [['LeeSin', 5, 150_000]], { style: style({ first_blood_rate: 0.62 }) });
  const zed = profile('p-zed', 'MID', [['Zed', 7, 412_000]]);

  it('timeline null / undefined, Clash fields null: identical draft and plan outputs', () => {
    const d = draft([foe('Sett')], [lee, zed]);
    const ref = recommendDraft([], d, catalog);
    const nulls = [
      { ...lee, style: { ...lee.style!, timeline: null }, clash_position: null, clash_team: null },
      { ...zed, clash_position: null, clash_team: null },
    ];
    expect(json(recommendDraft([], { ...d, enemy_profiles: nulls }, catalog))).toBe(json(ref));
    const allyTeam: Pick[] = [{ role: 'JUNGLE', champion_id: 'Vi' }];
    const enemyTeam: Pick[] = [{ role: 'JUNGLE', champion_id: 'LeeSin' }, { role: 'MID', champion_id: 'Zed' }];
    const plan = buildMatchupPlan(allyTeam, enemyTeam, catalog, { enemy_profiles: [lee, zed] });
    expect(json(buildMatchupPlan(allyTeam, enemyTeam, catalog, { enemy_profiles: nulls }))).toBe(json(plan));
  });

  it('fewer than 2 timelines are ignored', () => {
    const one = { ...lee, style: style({ first_blood_rate: 0.62 }, { ...GANKER_TL, games: 1 }) };
    expect(json(insight(one))).toBe(json(insight(lee)));
  });

  it('UNSELECTED without team is unknown; FILL keeps every prediction', () => {
    const d = draft([], [zed]);
    const ref = recommendDraft([], d, catalog);
    expect(json(recommendDraft([], draft([], [{ ...zed, clash_position: 'UNSELECTED' }]), catalog))).toBe(json(ref));
    const fill = recommendDraft([], draft([], [{ ...zed, clash_position: 'FILL' }]), catalog);
    expect(json(fill.predictions)).toBe(json(ref.predictions));
    expect(fill.enemy_players[0].style_tags).toEqual(['Poste Clash déclaré : Fill (tous rôles)']);
  });
});

// ----------------------------------------------------------------------------- timeline style

describe('timeline style tags, threats and attention points', () => {
  it('a jungler: early gank, early activity, fast level 6, few wards, late back (cited as m:ss)', () => {
    const ins = insight(ganker());
    expect(ins.style_tags).toEqual([
      'Jungler qui gank tôt : premier gank vers 3:20, surtout bot (sur 3 parties)',
      'Très actif avant 10 min (2,3 kills + assists par partie)',
      'Niveau 6 rapide (6:30)',
      'Pose peu de balises (0,3/min)',
      'Retour en base tardif (7:40)',
    ]);
    expect(ins.attention_points).toEqual([
      "Gank tôt (premier gank vers 3:20, surtout bot) : wardez l'entrée de jungle côté bot avant 2:50",
      'Warde peu (0,3 balise par minute) : tendez des embuscades dans sa zone',
      'Niveau 6 rapide (6:30) : respectez son ultime dès 6:00',
      'Retour en base tardif (7:40) : punissable par un recall synchronisé',
    ]);
  });

  it('thresholds: just past them gives nothing', () => {
    const near = profile('p', 'JUNGLE', [['LeeSin', 2, 40_000]], {
      style: style({}, { first_gank_minute: 4.05, kills_before_10: 1.9, level6_minute: 6.8, wards_per_min: 0.36, first_back_minute: 6.95, deaths_before_10: 1.4, gold_diff_10: 399, cs_10: 74 }),
    });
    expect(insight(near).style_tags).toEqual([]);
    expect(insight(near).attention_points).toEqual([]);
  });

  it('farming jungler: late first gank', () => {
    const p = profile('p', 'JUNGLE', [['LeeSin', 2, 40_000]], { style: style({}, { first_gank_minute: 6.67, first_gank_lane: 'TOP' }) });
    const ins = insight(p);
    expect(ins.style_tags).toEqual(['Jungler farmeur : premier gank vers 6:40 seulement']);
    expect(ins.attention_points).toEqual(['Farme sa jungle (premier gank vers 6:40) : jouez agressif en lane avant 6:10']);
  });

  it('laner: gold at 10:00, cs at 10:00, early deaths, early back; gank facts never for a laner', () => {
    const p = profile('p', 'TOP', [['Darius', 2, 40_000]], {
      style: style({}, { gold_diff_10: 452, cs_10: 88, deaths_before_10: 1.7, first_back_minute: 3.33, first_gank_minute: 3, level6_minute: 5.83 }),
    });
    const ins = insight(p);
    expect(ins.style_tags).toEqual([
      "Prend l'avance en lane : +452 or à 10 min en moyenne",
      'Meurt souvent tôt (1,7 mort avant 10 min par partie)',
      'Niveau 6 rapide (5:50)',
      'Farm solide : 88 cs à 10 min',
      'Retour en base précoce (3:20)',
    ]);
    expect(ins.attention_points).toEqual([
      'Niveau 6 rapide (5:50) : respectez son ultime dès 5:20',
      'Meurt souvent tôt (1,7 mort avant 10 min par partie) : jouez autour de lui avant 10:00',
    ]);
    const losing = profile('q', 'MID', [['Ahri', 2, 40_000]], { style: style({}, { gold_diff_10: -520, cs_10: 52 }) });
    const l = insight(losing);
    expect(l.style_tags).toEqual(['Perd souvent sa lane : -520 or à 10 min en moyenne', 'Farm faible : 52 cs à 10 min']);
    expect(l.attention_points).toContain('Perd souvent sa lane (-520 or à 10 min) : jouez agressif contre lui');
  });

  it('the bigger sample wins: early_lead, cs/min and vision reads are kept over their timeline twins', () => {
    const p = profile('p', 'TOP', [['Darius', 2, 40_000]], {
      style: style({ early_lead: 650, cs_per_min: 8.2, vision_per_min: 0.4 }, { gold_diff_10: -500, cs_10: 50, wards_per_min: 0.1 }),
    });
    expect(insight(p).style_tags).toEqual([
      "Prend l'avance en lane (+650 or et XP en moyenne)",
      'Farm avant tout (8,2 cs/min)',
      'Vision faible (0,4 par minute)',
    ]);
  });

  it('timelines alone (style on too few games) still give the timeline facts', () => {
    const p = profile('p', 'JUNGLE', [['LeeSin', 2, 40_000]], { style: style({ games: 2 }, GANKER_TL) });
    expect(insight(p).style_tags[0]).toBe('Jungler qui gank tôt : premier gank vers 3:20, surtout bot (sur 3 parties)');
  });

  it('matchup plan: attention points tied to the timings', () => {
    const allyTeam: Pick[] = [
      { role: 'TOP', champion_id: 'Darius' },
      { role: 'JUNGLE', champion_id: 'Vi' },
      { role: 'BOTTOM', champion_id: 'Jinx' },
    ];
    const enemyTeam: Pick[] = [
      { role: 'TOP', champion_id: 'Fiora' },
      { role: 'JUNGLE', champion_id: 'LeeSin' },
      { role: 'MID', champion_id: 'Zed' },
    ];
    const fio = profile('p-fio', 'TOP', [['Fiora', 2, 40_000]], { style: style({}, { first_back_minute: 7.67 }), champion_id: 'Fiora', role: 'TOP' });
    const zed = profile('p-zed', 'MID', [['Zed', 2, 40_000]], { style: style({}, { level6_minute: 5.83 }), champion_id: 'Zed', role: 'MID' });
    const plan = buildMatchupPlan(allyTeam, enemyTeam, catalog, { enemy_profiles: [ganker({ champion_id: 'LeeSin', role: 'JUNGLE' }), fio, zed] });
    expect(plan.attention).toEqual([
      {
        phase: 'early',
        text: "Early : leur jungler (Lee Sin, premier gank vers 3:20, surtout bot) gank tôt : wardez l'entrée de jungle côté bot avant 2:50 et jouez prudemment en bot.",
        enemy_puuid: 'p-lee',
      },
      {
        phase: 'early',
        text: 'Early : leur jungler (Lee Sin, niveau 6 vers 6:30) a son ultime tôt : attendez-vous à un gank avec ultime dès 6:00.',
        enemy_puuid: 'p-lee',
      },
      {
        phase: 'early',
        text: 'Early : leur mid (Zed, niveau 6 vers 5:50) a son ultime tôt : respectez-le dès 5:20, ne restez pas en lane avec peu de PV.',
        enemy_puuid: 'p-zed',
      },
      { phase: 'mid', text: 'Mid : leur jungler (Lee Sin, 0,3 balise par minute) warde peu : tendez des embuscades sur son chemin.', enemy_puuid: 'p-lee' },
    ]);
    // the top's late back shows once the jungler's points are gone
    const plan2 = buildMatchupPlan(allyTeam, enemyTeam, catalog, { enemy_profiles: [fio] });
    expect(plan2.attention).toEqual([
      {
        phase: 'early',
        text: "Early : leur top (Fiora, premier retour en base vers 7:40) rentre tard : rentrez avant lui sur une vague poussée et revenez avec l'avantage d'objets avant 7:40.",
        enemy_puuid: 'p-fio',
      },
    ]);
    // mid gank: both jungle entrances around the mid
    const mid = ganker({ champion_id: 'LeeSin', role: 'JUNGLE', style: style({}, { first_gank_minute: 3.5, first_gank_lane: 'MID' }) });
    expect(buildMatchupPlan(allyTeam, enemyTeam, catalog, { enemy_profiles: [mid] }).attention![0].text).toBe(
      'Early : leur jungler (Lee Sin, premier gank vers 3:30, surtout mid) gank tôt : wardez les deux entrées de jungle autour du mid avant 3:00 et jouez prudemment en mid.',
    );
  });
});

// ----------------------------------------------------------------------------- Clash

describe('Clash declared positions', () => {
  // recent games say mid (6) / jungle (4), the Clash team declared them jungle
  const sylas = (pos: EnemyPlayerProfile['clash_position'] = null, team: EnemyPlayerProfile['clash_team'] = null): EnemyPlayerProfile => ({
    ...profile('p-syl', 'MID', [['Sylas', 4, 80_000], ['Ahri', 3, 30_000]]),
    recent: {
      games: 10,
      roles: { MID: 6, JUNGLE: 4 },
      champions: [
        { champion_id: 'Sylas', games: 4, wins: 2, kills: 5, deaths: 5, assists: 5, role: 'JUNGLE' },
        { champion_id: 'Ahri', games: 3, wins: 2, kills: 5, deaths: 5, assists: 5, role: 'MID' },
      ],
    },
    ...(pos ? { clash_position: pos, source: 'clash' as const } : {}),
    ...(team ? { clash_team: team } : {}),
  });
  const pred = (adv: ReturnType<typeof recommendDraft>, role: Role) => adv.predictions.find((p) => p.role === role);

  it('predictions: the declared role wins over the recent role shares', () => {
    const plain = recommendDraft([], draft([], [sylas()]), catalog);
    expect(pred(plain, 'MID')!.candidates[0].player_puuid).toBe('p-syl');
    expect(plain.enemy_players[0].role).toBe('MID');
    const res = recommendDraft([], draft([], [sylas('JUNGLE')]), catalog);
    expect(pred(res, 'JUNGLE')!.candidates[0]).toMatchObject({ champion_id: 'Sylas', player_puuid: 'p-syl' });
    expect(pred(res, 'MID')).toBeUndefined();
    expect(res.enemy_players[0]).toMatchObject({ role: 'JUNGLE', likely_picks: ['Sylas'] });
    // an explicit role (revealed in game) still wins over the declared one
    const explicit = recommendDraft([], draft([], [{ ...sylas('JUNGLE'), role: 'MID' }]), catalog);
    expect(explicit.enemy_players[0].role).toBe('MID');
  });

  it('two players on the same main role: the declared positions split them', () => {
    const a = { ...profile('p-a', 'MID', [['Zed', 6, 100_000]]), clash_position: 'MIDDLE' as const };
    const b = { ...profile('p-b', 'MID', [['Lux', 5, 90_000]]), clash_position: 'UTILITY' as const };
    const res = recommendDraft([], draft([], [b, a]), catalog);
    expect(pred(res, 'MID')!.candidates[0].player_puuid).toBe('p-a');
    expect(pred(res, 'SUPPORT')!.candidates[0]).toMatchObject({ champion_id: 'Lux', player_puuid: 'p-b' });
    const plain = recommendDraft([], draft([], [profile('p-b', 'MID', [['Lux', 5, 90_000]]), profile('p-a', 'MID', [['Zed', 6, 100_000]])]), catalog);
    expect(pred(plain, 'SUPPORT')).toBeUndefined();
  });

  it('slot inference: a locked champion goes to the player declared in one of its roles', () => {
    // Sett (top / support): 1 game only, not "clearly" in the pool — no link without Clash
    const sup = profile('p-sup', 'TOP', [['Sett', 1, 5_000], ['Thresh', 5, 90_000]]);
    const mid = profile('p-mid', 'MID', [['Ahri', 6, 100_000]]);
    const plain = recommendDraft([], draft([foe('Sett')], [sup, mid]), catalog);
    expect(plain.enemy_players.every((p) => p.champion_id === null)).toBe(true);
    const res = recommendDraft([], draft([foe('Sett')], [{ ...sup, clash_position: 'UTILITY' }, { ...mid, clash_position: 'MIDDLE' }]), catalog);
    expect(res.enemy_players[0]).toMatchObject({ puuid: 'p-sup', champion_id: 'Sett', role: 'SUPPORT' });
    expect(res.enemy_players[1]).toMatchObject({ puuid: 'p-mid', champion_id: null, role: 'MID' });
    // two players declared in the champion's roles: ambiguous, no link
    const top = { ...profile('p-top', 'TOP', [['Sett', 1, 5_000]]), clash_position: 'TOP' as const };
    const amb = recommendDraft([], draft([foe('Sett')], [{ ...sup, clash_position: 'UTILITY' }, top]), catalog);
    expect(amb.enemy_players.every((p) => p.champion_id === null)).toBe(true);
  });

  it('slot inference: a linked flex champion takes the declared role', () => {
    // Sett clearly in the pool (links by pool); recent games say top, the Clash position says support
    const p = profile('p-sett', 'TOP', [['Sett', 5, 90_000]]);
    expect(recommendDraft([], draft([foe('Sett')], [p]), catalog).enemy_players[0]).toMatchObject({ champion_id: 'Sett', role: 'TOP' });
    const res = recommendDraft([], draft([foe('Sett')], [{ ...p, clash_position: 'UTILITY' }]), catalog);
    expect(res.enemy_players[0]).toMatchObject({ champion_id: 'Sett', role: 'SUPPORT' });
    expect(res.predictions.map((x) => x.role)).not.toContain('SUPPORT');
  });

  it('matchup plan: a profile without champion is matched to the slot of its declared role', () => {
    const enemyTeam: Pick[] = [
      { role: 'TOP', champion_id: 'Fiora' },
      { role: 'MID', champion_id: 'Zed' },
    ];
    const p = profile('p-x', 'TOP', [['Darius', 5, 60_000]]);
    expect(buildMatchupPlan([], enemyTeam, catalog, { enemy_profiles: [p] }).enemy_players![0].champion_id).toBeNull();
    const plan = buildMatchupPlan([], enemyTeam, catalog, { enemy_profiles: [{ ...p, clash_position: 'MIDDLE' }] });
    expect(plan.enemy_players![0]).toMatchObject({ champion_id: 'Zed', role: 'MID' });
  });

  it('insight cites the declared position once and the team name at most once, verbatim', () => {
    const team = { id: 't1', name: 'Le Arcane', abbreviation: 'ARC' };
    const res = recommendDraft([], draft([], [sylas('JUNGLE', team)]), catalog);
    const tags = res.enemy_players[0].style_tags;
    expect(tags[0]).toBe('Poste Clash déclaré : Jungle · équipe Le Arcane [ARC]');
    const strings = allStrings(res);
    expect(strings.filter((s) => s.includes('Le Arcane')).length).toBe(1);
    expect(strings.filter((s) => s.includes('Poste Clash déclaré')).length).toBe(1);
    // FILL with a team; team without position
    expect(insight({ ...sylas('FILL', team) }).style_tags[0]).toBe('Poste Clash déclaré : Fill (tous rôles) · équipe Le Arcane [ARC]');
    expect(insight({ ...sylas(null, team) }).style_tags[0]).toBe('Joueur Clash · équipe Le Arcane [ARC]');
    // matchup plan too
    const plan = buildMatchupPlan([], [{ role: 'JUNGLE', champion_id: 'Sylas' }], catalog, { enemy_profiles: [sylas('JUNGLE', team)] });
    expect(plan.enemy_players![0].style_tags[0]).toBe('Poste Clash déclaré : Jungle · équipe Le Arcane [ARC]');
  });
});

// ----------------------------------------------------------------------------- elision, determinism, performance

describe('timeline + Clash: elision, determinism and performance', () => {
  const ROLES: Role[] = ['TOP', 'JUNGLE', 'MID', 'BOTTOM', 'SUPPORT'];
  const POS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'] as const;
  const all = catalog.all();
  const profiles: EnemyPlayerProfile[] = ROLES.map((role, i) => {
    const list = all.filter((c) => c.roles.includes(role)).slice(i, i + 20);
    return {
      ...profile(
        `e${i}`,
        ROLES[(i + 1) % 5],
        list.map((c, k) => [c.id, k < 15 ? 1 + (k % 4) : 0, 200_000 - k * 9_000] as [string, number, number]),
        { style: style({ first_blood_rate: 0.1 * i }, { ...GANKER_TL, gold_diff_10: -450 + 200 * i, level6_minute: 5.5 + i * 0.5, first_back_minute: 3 + i }) },
      ),
      clash_position: POS[i],
      clash_team: { id: 't', name: 'Équipe Ardente', abbreviation: 'EA' },
    };
  });
  const d = draft([foe('Zed'), foe('Malphite')], profiles, { side: 'blue' });

  it('every sentence is elided, outputs are deterministic', () => {
    const a = recommendDraft([], d, catalog);
    expect(json(recommendDraft([], d, catalog))).toBe(json(a));
    for (const s of allStrings({ ...a, enemy_players: a.enemy_players.map((x) => ({ ...x, riot_id: null })) })) expect(BAD_ELISION.test(s)).toBe(false);
    const enemyTeam: Pick[] = ROLES.map((role) => ({ role, champion_id: all.find((c) => c.roles[0] === role)!.id }));
    const plan = buildMatchupPlan([], enemyTeam, catalog, { enemy_profiles: profiles });
    for (const s of allStrings(plan)) expect(BAD_ELISION.test(s)).toBe(false);
    expect(plan.attention!.length).toBeGreaterThan(0);
    // the declared roles drive the predicted roles
    expect(a.enemy_players.map((p) => p.role)).toEqual(ROLES);
  });

  it('recommendDraft stays under 300 ms', () => {
    recommendDraft([], d, catalog);
    const t0 = performance.now();
    recommendDraft([], d, catalog);
    expect(performance.now() - t0).toBeLessThan(300);
  });
});
