// Ported from the former Python engine_fixtures.py: in-test champion data independent from the curated JSON.
import type { PlayerInput, PlayerPreferences, Role } from '../../api/types';
import { buildCatalog, type Catalog, type RawMeta } from '../index';
import { ARCHETYPE_ROLES, ARCHETYPE_TRAITS, TRAITS } from '../tables';

// id, key, name, roles, archetype, damage, region, groups, traits (engage peel poke wc split pick tf early late mob front cc sus obj)
const RAW: [string, number, string, string, string, string, string, string, string][] = [
  ['Malphite', 54, 'Malphite', 'TOP SUPPORT', 'vanguard', 'AP', 'ixtal', '', '31120131213311'],
  ['Garen', 86, 'Garen', 'TOP', 'juggernaut', 'AD', 'demacia', '', '10022022212131'],
  ['Darius', 122, 'Darius', 'TOP', 'juggernaut', 'AD', 'noxus', '', '10022023202132'],
  ['Fiora', 114, 'Fiora', 'TOP', 'skirmisher', 'AD', 'demacia', '', '00013012320022'],
  ['Teemo', 17, 'Teemo', 'TOP', 'specialist', 'AP', 'bandle_city', 'yordle', '00212102110101'],
  ['Poppy', 78, 'Poppy', 'TOP JUNGLE SUPPORT', 'warden', 'AD', 'demacia', 'yordle', '23011122113311'],
  ['LeeSin', 64, 'Lee Sin', 'JUNGLE', 'diver', 'AD', 'ionia', '', '21011213131212'],
  ['JarvanIV', 59, 'Jarvan IV', 'JUNGLE', 'diver', 'AD', 'demacia', '', '30010123122302'],
  ['Amumu', 32, 'Amumu', 'JUNGLE SUPPORT', 'vanguard', 'AP', 'shurima', 'undead', '31010131213301'],
  ['Khazix', 121, "Kha'Zix", 'JUNGLE', 'assassin', 'AD', 'void', 'void_born', '00011312230002'],
  ['Sejuani', 113, 'Sejuani', 'JUNGLE', 'vanguard', 'AD', 'freljord', '', '31010132113312'],
  ['Hecarim', 120, 'Hecarim', 'JUNGLE', 'diver', 'AD', 'shadow_isles', 'undead', '30021122232212'],
  ['Vi', 254, 'Vi', 'JUNGLE', 'diver', 'AD', 'piltover', '', '30010312122312'],
  ['Ahri', 103, 'Ahri', 'MID', 'burst_mage', 'AP', 'ionia', 'vastaya', '10220312230211'],
  ['Orianna', 61, 'Orianna', 'MID', 'battlemage', 'AP', 'piltover', 'machine', '12230131310201'],
  ['Zed', 238, 'Zed', 'MID', 'assassin', 'AD', 'ionia', '', '00122312130001'],
  ['Veigar', 45, 'Veigar', 'MID', 'burst_mage', 'AP', 'bandle_city', 'yordle', '10120221300301'],
  ['Xerath', 101, 'Xerath', 'MID SUPPORT', 'artillery', 'AP', 'shurima', 'ascended', '00330121200201'],
  ['Viktor', 112, 'Viktor', 'MID', 'battlemage', 'AP', 'zaun', '', '00231031300101'],
  ['Syndra', 134, 'Syndra', 'MID', 'burst_mage', 'AP', 'ionia', '', '00220222200201'],
  ['Yasuo', 157, 'Yasuo', 'MID TOP', 'skirmisher', 'AD', 'ionia', '', '10022121330111'],
  ['Jinx', 222, 'Jinx', 'BOTTOM', 'marksman', 'AD', 'zaun', '', '00131031300103'],
  ['Caitlyn', 51, 'Caitlyn', 'BOTTOM', 'marksman', 'AD', 'piltover', '', '00321113200102'],
  ['Ezreal', 81, 'Ezreal', 'BOTTOM', 'marksman', 'AD', 'piltover', '', '00311112230002'],
  ['Tristana', 18, 'Tristana', 'BOTTOM MID', 'marksman', 'AD', 'bandle_city', 'yordle', '00021022320103'],
  ['Kaisa', 145, "Kai'Sa", 'BOTTOM', 'marksman', 'MIXED', 'void', 'void_born', '00120221320002'],
  ['Lulu', 117, 'Lulu', 'SUPPORT', 'enchanter', 'AP', 'bandle_city', 'yordle', '03100122200220'],
  ['Leona', 89, 'Leona', 'SUPPORT', 'vanguard', 'AP', 'targon', '', '31000223113300'],
  ['Thresh', 412, 'Thresh', 'SUPPORT', 'catcher', 'AP', 'shadow_isles', 'undead', '23000322211300'],
  ['Janna', 40, 'Janna', 'SUPPORT', 'enchanter', 'AP', 'zaun', '', '03100011210220'],
  ['Nautilus', 111, 'Nautilus', 'SUPPORT', 'vanguard', 'AP', 'bilgewater', '', '31010222103301'],
  ['Kayle', 10, 'Kayle', 'TOP', 'skirmisher', 'MIXED', 'demacia', 'celestial', '00122020310012'],
  ['Morgana', 25, 'Morgana', 'SUPPORT MID', 'burst_mage', 'AP', 'demacia', 'celestial', '12120221200301'],
  ['Rumble', 68, 'Rumble', 'TOP MID', 'battlemage', 'AP', 'bandle_city', 'yordle', '10121032211101'],
  ['Kennen', 85, 'Kennen', 'TOP', 'specialist', 'AP', 'ionia', 'yordle', '20211131220300'],
  ['Gnar', 150, 'Gnar', 'TOP', 'specialist', 'AD', 'freljord', 'yordle', '20211032212201'],
];

const REGIONS = ['noxus', 'demacia', 'ionia', 'freljord', 'zaun', 'piltover', 'shurima', 'targon', 'ixtal', ''];

export function baseMeta(): Record<string, RawMeta> {
  const out: Record<string, RawMeta> = {};
  for (const [cid, key, name, roles, arch, dmg, region, groups, traits] of RAW) {
    out[cid] = {
      name,
      key,
      roles: roles.split(' '),
      archetype: arch,
      damage_type: dmg,
      region,
      groups: groups ? groups.split(' ') : [],
      traits: Object.fromEntries(TRAITS.map((t, i) => [t, Number(traits[i])])),
      power_spikes: [`niveau 6 (${name})`],
      playstyle: `Style de jeu de ${name}.`,
      counter_tips: `Conseil contre ${name}. Second conseil.`,
    };
  }
  return out;
}

/** Deterministic filler champions so the catalog has a realistic size (~170). */
export function syntheticMeta(count = 130): Record<string, RawMeta> {
  const archetypes = Object.keys(ARCHETYPE_TRAITS).sort();
  const out: Record<string, RawMeta> = {};
  for (let i = 0; i < count; i++) {
    const arch = archetypes[i % archetypes.length];
    const traits: Record<string, number> = { ...ARCHETYPE_TRAITS[arch] } as Record<string, number>;
    const t = TRAITS[i % TRAITS.length];
    traits[t] = Math.min(3, (traits[t] ?? 0) + 1);
    const id = String(i).padStart(3, '0');
    out[`Synth${id}`] = {
      name: `Synth ${id}`,
      key: 2000 + i,
      roles: [...ARCHETYPE_ROLES[arch]],
      archetype: arch,
      damage_type: ['AD', 'AP', 'MIXED'][i % 3],
      region: REGIONS[i % REGIONS.length],
      groups: [],
      traits,
    };
  }
  return out;
}

let small: Catalog | null = null;
let big: Catalog | null = null;

export function smallCatalog(): Catalog {
  small ??= buildCatalog([], '', baseMeta());
  return small;
}

export function bigCatalog(): Catalog {
  big ??= buildCatalog([], '', { ...baseMeta(), ...syntheticMeta() });
  return big;
}

export function player(
  pid: string,
  roles: Role[],
  pool: Record<string, number>,
  prefs: Partial<PlayerPreferences> = {},
): PlayerInput {
  return {
    player_id: pid,
    name: pid[0].toUpperCase() + pid.slice(1),
    preferences: { roles, wanted_archetypes: [], wanted_champions: [], avoided_champions: [], ...prefs },
    role_games: {},
    pool: Object.entries(pool).map(([c, v]) => ({
      champion_id: c,
      comfort: v,
      desire: 0.3,
      sources: ['mastery'],
      mastery_points: Math.trunc(v * 200_000),
      mastery_level: 7,
      recent_games: 0,
      recent_wins: 0,
    })),
  };
}

export function fivePlayers(): PlayerInput[] {
  return [
    player('alice', ['TOP', 'JUNGLE'], { Malphite: 0.9, Garen: 0.7, Darius: 0.6, Teemo: 0.5, Gnar: 0.4 }),
    player('bob', ['JUNGLE'], { LeeSin: 0.9, Amumu: 0.7, JarvanIV: 0.6, Sejuani: 0.5, Vi: 0.4 }),
    player('carl', ['MID'], { Ahri: 0.9, Orianna: 0.8, Zed: 0.6, Veigar: 0.5, Xerath: 0.4 }, {
      wanted_archetypes: ['assassin'],
    }),
    player('dana', ['BOTTOM'], { Jinx: 0.9, Caitlyn: 0.8, Ezreal: 0.6, Tristana: 0.5 }),
    player('eve', ['SUPPORT'], { Leona: 0.9, Thresh: 0.8, Lulu: 0.6, Janna: 0.5, Nautilus: 0.4 }),
  ];
}
