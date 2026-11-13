import { useId, useMemo, useState } from 'react';
import type { ChampionInfo, MetaStats, Role } from '../../api/types';
import { ROLES } from '../../api/types';
import {
  buildTierRows,
  DEFAULT_DIR,
  DEFAULT_MIN_GAMES,
  filterRows,
  LOW_SAMPLE_GAMES,
  sortRows,
  type SortDir,
  type SortKey,
  type TierRow,
} from '../../api/metaTier';
import { loadLocal, saveLocal } from '../../lib/storage';
import { ROLE_LABEL, ROLE_SHORT } from '../../lib/format';
import { ChampionAvatar } from '../ChampionAvatar';
import { fmtInt, fmtPct } from './format';

const MIN_GAMES_CHOICES = [0, 10, 20, 50, 100, 200];

const COLUMNS: { key: SortKey; label: string; title: string }[] = [
  { key: 'name', label: 'Champion', title: 'Nom du champion' },
  { key: 'tier', label: 'Tier', title: 'Winrate lissé (ramené vers 50 % quand il y a peu de parties)' },
  { key: 'winrate', label: 'Victoires', title: 'Winrate brut dans ce rôle' },
  { key: 'pickRate', label: 'Pick', title: 'Parties dans ce rôle / parties du patch' },
  { key: 'banRate', label: 'Ban', title: 'Parties où il est banni / parties du patch' },
  { key: 'games', label: 'Parties', title: 'Nombre de parties dans ce rôle' },
];

const ROLE_TAB: Record<Role, string> = { TOP: 'Top', JUNGLE: 'Jungle', MID: 'Mid', BOTTOM: 'ADC', SUPPORT: 'Support' };

function wrClass(r: TierRow): string {
  if (r.lowSample) return 'muted';
  if (r.winrate >= 0.51) return 'pos';
  if (r.winrate <= 0.49) return 'neg';
  return '';
}

/** Per-role tier list: role tabs, search, min-games filter, sortable columns. */
export function TierTable({ meta, champs, onOpen }: {
  meta: MetaStats;
  champs: Map<string, ChampionInfo>;
  onOpen: (championId: string, role: Role) => void;
}) {
  const id = useId();
  const [role, setRoleState] = useState<Role>(() => {
    const saved = loadLocal<string>('meta-role', 'MID');
    return (ROLES as string[]).includes(saved) ? (saved as Role) : 'MID';
  });
  const setRole = (r: Role) => {
    setRoleState(r);
    saveLocal('meta-role', r);
  };
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'tier', dir: 'desc' });
  const [minGames, setMinGames] = useState(DEFAULT_MIN_GAMES);
  const [query, setQuery] = useState('');

  const all = useMemo(() => buildTierRows(meta, role, (cid) => champs.get(cid)?.name ?? cid), [meta, role, champs]);
  const rows = useMemo(() => sortRows(filterRows(all, { minGames, query }), sort.key, sort.dir), [all, minGames, query, sort]);
  const counts = useMemo(
    () => Object.fromEntries(ROLES.map((r) => [r, buildTierRows(meta, r).length])) as Record<Role, number>,
    [meta],
  );
  const hidden = all.length - rows.length;

  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: DEFAULT_DIR[key] }));

  return (
    <section className="section tier" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="sr-only">Tier list par rôle</h2>
      <div className="tabs tier__tabs" role="tablist" aria-label="Rôle">
        {ROLES.map((r) => (
          <button
            key={r}
            type="button"
            role="tab"
            id={`${id}-tab-${r}`}
            aria-selected={role === r}
            aria-controls={`${id}-panel`}
            className={`tab tier__tab tier__tab--${r.toLowerCase()} ${role === r ? 'is-active' : ''}`}
            onClick={() => setRole(r)}
            title={ROLE_LABEL[r]}
            aria-label={`${ROLE_TAB[r]} (${counts[r]} champions)`}
          >
            <span className="tier__tab-full">{ROLE_TAB[r]}</span>
            <span className="tier__tab-short" aria-hidden="true">{ROLE_SHORT[r]}</span>
            <span className="tier__count">{counts[r]}</span>
          </button>
        ))}
      </div>

      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${role}`} className="stack">
        <div className="tier__tools">
          <div className="field tier__search">
            <label className="field__label" htmlFor={`${id}-q`}>Rechercher</label>
            <input
              id={`${id}-q`}
              className="input"
              type="search"
              placeholder="Nom du champion…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="field tier__min">
            <label className="field__label" htmlFor={`${id}-min`}>Parties min.</label>
            <select id={`${id}-min`} className="input" value={minGames} onChange={(e) => setMinGames(Number(e.target.value))}>
              {MIN_GAMES_CHOICES.map((n) => <option key={n} value={n}>{n === 0 ? 'Toutes' : `≥ ${n}`}</option>)}
            </select>
          </div>
          <p className="tier__count-line hint" aria-live="polite">
            {rows.length} champion{rows.length > 1 ? 's' : ''}
            {hidden > 0 ? ` · ${hidden} masqué${hidden > 1 ? 's' : ''} (filtres)` : ''}
          </p>
        </div>

        {rows.length === 0 ? (
          <p className="notice">
            {all.length === 0
              ? `Aucune partie en ${ROLE_TAB[role]} sur ce patch pour l’instant.`
              : 'Aucun champion ne correspond : baisse le minimum de parties ou change la recherche.'}
          </p>
        ) : (
          <div className="table-wrap tier__wrap" role="region" aria-label={`Tier list ${ROLE_TAB[role]}`} tabIndex={0}>
            <table className="table tier__table">
              <thead>
                <tr>
                  {COLUMNS.map((c) => {
                    const on = sort.key === c.key;
                    return (
                      <th
                        key={c.key}
                        scope="col"
                        className={`tier__th tier__th--${c.key}`}
                        aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                      >
                        <button type="button" className={`sort ${on ? 'is-on' : ''}`} onClick={() => onSort(c.key)} title={c.title}>
                          {c.label}
                          <span className="sort__icon" aria-hidden="true">{on ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.lowSample ? 'is-low' : ''} onClick={() => onOpen(r.id, role)}>
                    <th scope="row" className="tier__champ">
                      <button
                        type="button"
                        className="tier__name"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpen(r.id, role);
                        }}
                        aria-label={`${r.name} : détails`}
                      >
                        <ChampionAvatar champion={champs.get(r.id)} id={r.id} size={28} />
                        <span className="tier__label">{r.name}</span>
                      </button>
                    </th>
                    <td>
                      {r.tier ? (
                        <span className={`tier-badge tier-badge--${r.tier.toLowerCase()}`} title={`Winrate lissé : ${fmtPct(r.score)}`}>{r.tier}</span>
                      ) : (
                        <span className="tier-badge tier-badge--na" title={`Moins de ${LOW_SAMPLE_GAMES} parties : pas assez pour classer`}>
                          <span aria-hidden="true">?</span><span className="sr-only">non classé</span>
                        </span>
                      )}
                    </td>
                    <td className={`tier__wr ${wrClass(r)}`}>
                      {fmtPct(r.winrate)}
                      {r.lowSample && (
                        <span className="tier__warn" title={`Échantillon faible : moins de ${LOW_SAMPLE_GAMES} parties`}>
                          <span aria-hidden="true">⚠</span>
                          <span className="sr-only">(échantillon faible, peu fiable)</span>
                        </span>
                      )}
                    </td>
                    <td>{fmtPct(r.pickRate)}</td>
                    <td>{fmtPct(r.banRate)}</td>
                    <td>{fmtInt(r.games)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint tier__legend">
          <strong>Tier</strong> : winrate lissé (ramené vers 50 % comme s’il y avait 100 parties de plus à 50 %), un champion
          peu joué ne peut pas être S par chance. <strong>Lignes grisées</strong> : moins de {LOW_SAMPLE_GAMES} parties,
          winrate peu fiable et pas de tier (« ? »). <strong>Pick</strong> et <strong>Ban</strong> : part des {fmtInt(meta.games)} parties du patch.
          Touchez une ligne pour voir les rôles et les face-à-face.
        </p>
      </div>
    </section>
  );
}
