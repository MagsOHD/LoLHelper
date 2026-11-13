import { describe, expect, it } from 'vitest';
import {
  aggregateTimelines,
  extractTimelineStyle,
  formatClock,
  pickTimelineGames,
  timelineGameFacts,
} from './timeline';
import m8 from './__fixtures__/match_EUW1_7000000008.json';
import m9 from './__fixtures__/match_EUW1_7000000009.json';
import m10 from './__fixtures__/match_EUW1_7000000010.json';
import m11 from './__fixtures__/match_EUW1_7000000011.json';
import t8 from './__fixtures__/timeline_EUW1_7000000008.json';
import t10 from './__fixtures__/timeline_EUW1_7000000010.json';

const ENEMY = 'enemy-puuid-scouted-0001';
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('timeline game facts', () => {
  it('jungle game: 10:00 frame vs the enemy jungler, early takedowns, first gank, back, wards, level 6', () => {
    const f = timelineGameFacts(t8, m8, ENEMY)!;
    expect(f).toEqual({
      role: 'JUNGLE',
      gold_diff_10: 450, // 3600 vs MonkeyKing's 3150
      cs_10: 68, // 6 minions + 62 jungle monsters
      kills_before_10: 2, // kill at 1:40 (on the enemy jungler) + assist at 3:20; the 10:10 kill is too late
      deaths_before_10: 1,
      first_gank: { minute: 200_000 / 60_000, lane: 'BOTTOM' }, // assist on their ADC; the jungler kill is no gank
      first_back_minute: 460_000 / 60_000, // 7:40 (purchases before 2:00 are the start)
      wards: 9, // creator 1, UNDEFINED excluded, other players ignored
      minutes: 30,
      level6_minute: 350_000 / 60_000, // LEVEL_UP event
    });
  });

  it('lane game: gold vs the lane opponent, level 6 from the frames, no gank field', () => {
    const f = timelineGameFacts(t10, m10, ENEMY)!;
    expect(f.role).toBe('MID');
    expect(f.gold_diff_10).toBe(-400);
    expect(f.cs_10).toBe(85);
    expect([f.kills_before_10, f.deaths_before_10]).toEqual([1, 1]);
    expect(f.first_gank).toBeUndefined();
    expect(f.first_back_minute).toBeCloseTo(380_000 / 60_000);
    expect(f.level6_minute).toBeCloseTo(420_050 / 60_000); // no LEVEL_UP event: first frame at level 6
    expect([f.wards, f.minutes]).toEqual([4, 20]);
  });

  it('jungler without a gank before 8:00, participants given by info.participants, mismatches rejected', () => {
    type Loose = { metadata: { participants: string[] }; info: { participants?: unknown[]; frames: { events: { type: string; timestamp: number }[] }[] } };
    const t = clone(t8) as unknown as Loose;
    for (const fr of t.info.frames) fr.events = fr.events.filter((e) => !(e.type === 'CHAMPION_KILL' && e.timestamp === 200_000));
    // info.participants wins over the metadata order.
    t.info.participants = t.metadata.participants.map((puuid, i) => ({ participantId: i + 1, puuid }));
    t.metadata.participants = [];
    expect(timelineGameFacts(t, m8, ENEMY)?.first_gank).toBeNull();
    expect(timelineGameFacts(t8, m10, ENEMY)).toBeNull(); // other game
    expect(timelineGameFacts(t8, m8, 'nobody')).toBeNull();
    expect(timelineGameFacts({ info: { frames: [] } }, m8, ENEMY)).toBeNull();
    expect(timelineGameFacts(null, m8, ENEMY)).toBeNull();
  });

  it('no gold difference when the lane opponent is ambiguous or the 10:00 frame is missing', () => {
    const twoJunglers = clone(m8);
    twoJunglers.info.participants[5].teamPosition = 'JUNGLE';
    expect(timelineGameFacts(t8, twoJunglers, ENEMY)?.gold_diff_10).toBeNull();
    const short = clone(t8);
    short.info.frames = short.info.frames.slice(0, 8);
    const f = timelineGameFacts(short, m8, ENEMY)!;
    expect([f.gold_diff_10, f.cs_10]).toEqual([null, null]);
  });
});

describe('timeline style (averages)', () => {
  it('averages the analysed games', () => {
    const style = extractTimelineStyle({ EUW1_7000000008: t8, EUW1_7000000010: t10 }, [m8, m9, m10], ENEMY);
    expect(style).toEqual({
      games: 2,
      gold_diff_10: 25, // (450 − 400) / 2
      cs_10: 76.5,
      kills_before_10: 1.5,
      deaths_before_10: 1,
      first_gank_minute: 3.33, // jungle games only
      first_gank_lane: 'BOTTOM',
      first_back_minute: 7, // (7:40 + 6:20) / 2
      wards_per_min: 0.26, // 13 wards / 50 minutes
      level6_minute: 6.42,
    });
  });

  it('null without usable timelines; lane ties broken top > mid > bot', () => {
    expect(extractTimelineStyle({}, [m8], ENEMY)).toBeNull();
    expect(extractTimelineStyle({ EUW1_7000000008: t8 }, [m10], ENEMY)).toBeNull(); // match not fetched
    const base = timelineGameFacts(t8, m8, ENEMY)!;
    const style = aggregateTimelines([
      { ...base, first_gank: { minute: 3, lane: 'BOTTOM' } },
      { ...base, first_gank: { minute: 4, lane: 'TOP' } },
      null,
    ])!;
    expect(style.games).toBe(2);
    expect(style.first_gank_lane).toBe('TOP');
    expect(style.first_gank_minute).toBe(3.5);
  });

  it('picks up to 3 recent Summoner’s Rift games of at least 10 minutes', () => {
    expect(pickTimelineGames([m8, m9, m10, m11], ENEMY)).toEqual(['EUW1_7000000008', 'EUW1_7000000009', 'EUW1_7000000010']);
    expect(pickTimelineGames([m11, m10, m9, m8], ENEMY, 2)).toEqual(['EUW1_7000000010', 'EUW1_7000000009']);
    const short = clone(m8);
    short.info.participants[0].timePlayed = 540;
    short.metadata.matchId = 'EUW1_1';
    expect(pickTimelineGames([short, m8], ENEMY)).toEqual(['EUW1_7000000008']); // 9-minute game skipped
    expect(pickTimelineGames([null, {}, m8], 'nobody')).toEqual([]);
  });

  it('formats minutes as m:ss', () => {
    expect([formatClock(3.3333), formatClock(7.6667), formatClock(5.8333), formatClock(0)]).toEqual(['3:20', '7:40', '5:50', '0:00']);
  });
});
