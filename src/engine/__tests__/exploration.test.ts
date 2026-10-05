import { describe, expect, it } from 'vitest';
import type { CompositionSuggestion, PlayerInput, Role } from '../../api/types';
import { buildCatalog, computePool, generateCompositions } from '..';

const catalog = buildCatalog([], 'offline');

const FRIENDS: [string, Role[], string[], [string, number][]][] = [
  ['Lucas', ['TOP', 'JUNGLE'], ['juggernaut', 'vanguard'], [['Darius', 0.9], ['Sett', 0.8], ['Ornn', 0.6], ['Garen', 0.7]]],
  ['Mags', ['JUNGLE', 'MID'], ['assassin', 'diver'], [['LeeSin', 0.8], ['Khazix', 0.7], ['JarvanIV', 0.6], ['Vi', 0.7]]],
  ['Theo', ['MID'], ['burst_mage', 'battlemage'], [['Ahri', 0.9], ['Syndra', 0.7], ['Orianna', 0.6], ['Lux', 0.8]]],
  ['Ines', ['BOTTOM'], ['marksman'], [['Jinx', 0.9], ['Caitlyn', 0.8], ['Ezreal', 0.7], ['Draven', 0.5]]],
  ['Sam', ['SUPPORT'], ['enchanter', 'catcher'], [['Thresh', 0.8], ['Lulu', 0.9], ['Leona', 0.6], ['Janna', 0.6]]],
];

const players: PlayerInput[] = FRIENDS.map(([name, roles, archetypes, pool]) => {
  const preferences = { roles, wanted_archetypes: archetypes, wanted_champions: [], avoided_champions: [] };
  const manual = pool.map(([champion_id, comfort]) => ({ champion_id, comfort }));
  return { player_id: name, name, preferences, role_games: {}, pool: computePool([], [], manual, preferences, catalog) };
});
const known = new Map(FRIENDS.map(([name, , , pool]) => [name, new Set(pool.map(([c]) => c))]));

function novelShare(res: CompositionSuggestion[]): number {
  const picks = res.flatMap((s) => s.picks);
  return picks.filter((p) => !known.get(p.player_id!)!.has(p.champion_id)).length / picks.length;
}

describe('exploration slider', () => {
  for (const theme of [null, 'engage']) {
    it(`sets the share of new champions per composition (theme ${theme ?? 'auto'})`, () => {
      const share = (exploration: number) => novelShare(generateCompositions(players, { theme, count: 5, exploration }, catalog));
      expect(share(0)).toBe(0);
      expect(share(0.2)).toBe(0.2);
      expect(share(0.4)).toBe(0.4);
      expect(share(0.6)).toBe(0.6);
      expect(share(0.8)).toBe(0.8);
      expect(share(1)).toBe(1);
    });
  }

  it('new champions still match the wanted character types', () => {
    const res = generateCompositions(players, { count: 5, exploration: 1 }, catalog);
    const wanted = new Map(FRIENDS.map(([name, , archetypes]) => [name, new Set(archetypes)]));
    const picks = res.flatMap((s) => s.picks);
    const matching = picks.filter((p) => wanted.get(p.player_id!)!.has(catalog.get(p.champion_id)!.archetype));
    expect(matching.length / picks.length).toBeGreaterThan(0.8);
    expect(picks.every((p) => p.reasons.includes('Découverte : un nouveau champion à essayer'))).toBe(true);
  });

  it('the comfort shown in the breakdown stays the real comfort', () => {
    const [top] = generateCompositions(players, { count: 1, exploration: 1 }, catalog);
    expect(top.picks.every((p) => p.comfort === 0)).toBe(true);
    expect(top.breakdown.comfort).toBeLessThan(30);
  });
});
