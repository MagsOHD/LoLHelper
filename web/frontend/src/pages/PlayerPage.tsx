import { useEffect, useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  useArchetypes, useChampionMap, usePlayer, useSyncPlayer, useUpdatePool, useUpdatePreferences,
} from '../api/hooks';
import type { ManualPoolEntry, Player, PlayerPreferences } from '../api/types';
import { ROLES } from '../api/types';
import { Avatar, ChampionAvatar } from '../components/ChampionAvatar';
import { ChampionPicker } from '../components/ChampionPicker';
import { Bar, Chip, EmptyState, ErrorMessage, RoleBadge, Skeleton } from '../components/ui';
import { formatDate, formatRank, ROLE_LABEL, ROLE_SHORT, SOURCE_LABEL } from '../lib/format';

type Tab = 'prefs' | 'pool' | 'mastery' | 'recent';
const TABS: { key: Tab; label: string }[] = [
  { key: 'prefs', label: 'Préférences' },
  { key: 'pool', label: 'Pool' },
  { key: 'mastery', label: 'Maîtrises' },
  { key: 'recent', label: 'Parties récentes' },
];

function samePrefs(a: PlayerPreferences, b: PlayerPreferences) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function ChampionChipList({ ids, onRemove, tone }: { ids: string[]; onRemove: (id: string) => void; tone?: 'gold' | 'red' }) {
  const champs = useChampionMap();
  if (!ids.length) return <p className="muted small">Aucun pour l’instant.</p>;
  return (
    <ul className="champ-chips">
      {ids.map((id) => {
        const c = champs.get(id);
        return (
          <li key={id} className={`champ-chip ${tone ? `champ-chip--${tone}` : ''}`}>
            <ChampionAvatar champion={c} id={id} size={24} />
            <span>{c?.name ?? id}</span>
            <button type="button" className="icon-btn icon-btn--sm" onClick={() => onRemove(id)} aria-label={`Retirer ${c?.name ?? id}`}>×</button>
          </li>
        );
      })}
    </ul>
  );
}

function PreferencesTab({ player }: { player: Player }) {
  const archetypes = useArchetypes();
  const update = useUpdatePreferences(player.id);
  const [draft, setDraft] = useState<PlayerPreferences>(player.preferences);
  const [saved, setSaved] = useState(false);

  useEffect(() => setDraft(player.preferences), [player.preferences]);
  const dirty = !samePrefs(draft, player.preferences);

  const set = (patch: Partial<PlayerPreferences>) => {
    setSaved(false);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const move = (i: number, dir: -1 | 1) => {
    const roles = [...draft.roles];
    const j = i + dir;
    if (j < 0 || j >= roles.length) return;
    [roles[i], roles[j]] = [roles[j], roles[i]];
    set({ roles });
  };
  const toggleArch = (k: string) =>
    set({ wanted_archetypes: draft.wanted_archetypes.includes(k) ? draft.wanted_archetypes.filter((x) => x !== k) : [...draft.wanted_archetypes, k] });

  const missingRoles = ROLES.filter((r) => !draft.roles.includes(r));

  return (
    <div className="stack-lg">
      <section className="card">
        <h3 className="card__title">Rôles préférés</h3>
        <p className="hint">Du plus aimé au moins aimé. Le premier rôle est celui que tu veux jouer en priorité.</p>
        {draft.roles.length > 0 && (
          <ol className="role-order">
            {draft.roles.map((r, i) => (
              <li key={r} className="role-order__item">
                <span className="role-order__rank">{i + 1}</span>
                <RoleBadge role={r} />
                <span className="role-order__label">{ROLE_LABEL[r]}</span>
                <span className="role-order__btns">
                  <button type="button" className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Monter ${ROLE_LABEL[r]}`}>↑</button>
                  <button type="button" className="icon-btn" onClick={() => move(i, 1)} disabled={i === draft.roles.length - 1} aria-label={`Descendre ${ROLE_LABEL[r]}`}>↓</button>
                  <button type="button" className="icon-btn" onClick={() => set({ roles: draft.roles.filter((x) => x !== r) })} aria-label={`Retirer ${ROLE_LABEL[r]}`}>×</button>
                </span>
              </li>
            ))}
          </ol>
        )}
        {missingRoles.length > 0 && (
          <div className="chips" role="group" aria-label="Ajouter un rôle">
            {missingRoles.map((r) => (
              <Chip key={r} onClick={() => set({ roles: [...draft.roles, r] })}>
                + {ROLE_SHORT[r]}
              </Chip>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h3 className="card__title">Types de personnages voulus</h3>
        {archetypes.isPending && <Skeleton height={32} />}
        {archetypes.isError && <ErrorMessage error={archetypes.error} />}
        {archetypes.data && (
          <>
            <div className="chips" role="group" aria-label="Types de personnages">
              {archetypes.data.map((a) => (
                <Chip key={a.key} selected={draft.wanted_archetypes.includes(a.key)} onClick={() => toggleArch(a.key)} title={a.description}>
                  {a.label}
                </Chip>
              ))}
            </div>
            <details className="details">
              <summary>Que signifient ces types ?</summary>
              <dl className="defs">
                {archetypes.data.map((a) => (
                  <div key={a.key}><dt>{a.label}</dt><dd>{a.description}</dd></div>
                ))}
              </dl>
            </details>
          </>
        )}
      </section>

      <div className="two-cols">
        <section className="card">
          <h3 className="card__title">Champions voulus</h3>
          <ChampionPicker
            label="Ajouter un champion voulu"
            exclude={[...draft.wanted_champions, ...draft.avoided_champions]}
            onSelect={(id) => set({ wanted_champions: [...draft.wanted_champions, id] })}
          />
          <ChampionChipList ids={draft.wanted_champions} tone="gold" onRemove={(id) => set({ wanted_champions: draft.wanted_champions.filter((x) => x !== id) })} />
        </section>
        <section className="card">
          <h3 className="card__title">Champions à éviter</h3>
          <ChampionPicker
            label="Ajouter un champion à éviter"
            exclude={[...draft.wanted_champions, ...draft.avoided_champions]}
            onSelect={(id) => set({ avoided_champions: [...draft.avoided_champions, id] })}
          />
          <ChampionChipList ids={draft.avoided_champions} tone="red" onRemove={(id) => set({ avoided_champions: draft.avoided_champions.filter((x) => x !== id) })} />
        </section>
      </div>

      {update.isError && <ErrorMessage error={update.error} />}
      <div className="sticky-actions">
        {saved && !dirty && <span className="ok" role="status">Préférences enregistrées ✓</span>}
        {dirty && <span className="muted small">Modifications non enregistrées</span>}
        <button type="button" className="btn btn--ghost" onClick={() => setDraft(player.preferences)} disabled={!dirty || update.isPending}>Annuler</button>
        <button type="button" className="btn btn--primary" disabled={!dirty || update.isPending} onClick={() => update.mutate(draft, { onSuccess: () => setSaved(true) })}>
          {update.isPending ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </div>
    </div>
  );
}

function PoolTab({ player }: { player: Player }) {
  const champs = useChampionMap();
  const update = useUpdatePool(player.id);
  const [draft, setDraft] = useState<ManualPoolEntry[]>(player.manual_pool);
  const id = useId();
  useEffect(() => setDraft(player.manual_pool), [player.manual_pool]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(player.manual_pool);

  return (
    <div className="stack-lg">
      <section className="card">
        <h3 className="card__title">Pool calculé</h3>
        <p className="hint">Confort = à quel point le joueur maîtrise le champion · Envie = à quel point il a envie de le jouer.</p>
        {player.pool.length === 0 ? (
          <EmptyState title="Pool vide">Ajoute des champions dans le pool manuel ci-dessous, ou indique des champions voulus dans les préférences.</EmptyState>
        ) : (
          <ul className="pool-list">
            {player.pool.map((e) => {
              const c = champs.get(e.champion_id);
              return (
                <li key={e.champion_id} className="pool-row">
                  <ChampionAvatar champion={c} id={e.champion_id} size={36} showName />
                  <div className="pool-row__bars">
                    <div className="mini"><span>Confort</span><Bar value={e.comfort} label={`Confort ${Math.round(e.comfort * 100)} %`} tone="teal" showValue size="sm" /></div>
                    <div className="mini"><span>Envie</span><Bar value={e.desire} label={`Envie ${Math.round(e.desire * 100)} %`} tone="gold" showValue size="sm" /></div>
                  </div>
                  <div className="pool-row__src">
                    {e.sources.map((s) => <Chip key={s} tone={s === 'wanted' ? 'gold' : s === 'manual' ? 'blue' : 'muted'}>{SOURCE_LABEL[s] ?? s}</Chip>)}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card">
        <h3 className="card__title">Pool manuel</h3>
        <p className="hint">Indique les champions que tu sais jouer et ton niveau de confort (utile sans clé API Riot).</p>
        <ChampionPicker
          label="Ajouter un champion au pool"
          exclude={draft.map((d) => d.champion_id)}
          onSelect={(cid) => setDraft((d) => [...d, { champion_id: cid, comfort: 0.5 }])}
        />
        {draft.length === 0 ? (
          <p className="muted small">Aucun champion ajouté manuellement.</p>
        ) : (
          <ul className="manual-list">
            {draft.map((e, i) => {
              const c = champs.get(e.champion_id);
              const sid = `${id}-${i}`;
              return (
                <li key={e.champion_id} className="manual-row">
                  <ChampionAvatar champion={c} id={e.champion_id} size={32} showName />
                  <label htmlFor={sid} className="sr-only">Confort sur {c?.name ?? e.champion_id}</label>
                  <input
                    id={sid}
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={Math.round(e.comfort * 100)}
                    onChange={(ev) => {
                      const v = Number(ev.target.value) / 100;
                      setDraft((d) => d.map((x, j) => (j === i ? { ...x, comfort: v } : x)));
                    }}
                    className="range"
                  />
                  <span className="manual-row__val">{Math.round(e.comfort * 100)}</span>
                  <button type="button" className="icon-btn" onClick={() => setDraft((d) => d.filter((_, j) => j !== i))} aria-label={`Retirer ${c?.name ?? e.champion_id}`}>×</button>
                </li>
              );
            })}
          </ul>
        )}
        {update.isError && <ErrorMessage error={update.error} />}
        <div className="row row--end">
          <button type="button" className="btn btn--ghost" onClick={() => setDraft(player.manual_pool)} disabled={!dirty || update.isPending}>Annuler</button>
          <button type="button" className="btn btn--primary" onClick={() => update.mutate(draft)} disabled={!dirty || update.isPending}>
            {update.isPending ? 'Enregistrement…' : 'Enregistrer le pool'}
          </button>
        </div>
      </section>
    </div>
  );
}

function MasteryTab({ player }: { player: Player }) {
  const champs = useChampionMap();
  if (!player.masteries.length) {
    return <EmptyState title="Aucune maîtrise">{player.puuid ? 'Synchronise le joueur pour récupérer ses maîtrises.' : 'Joueur manuel : les maîtrises Riot ne sont pas disponibles.'}</EmptyState>;
  }
  const max = Math.max(...player.masteries.map((m) => m.points), 1);
  return (
    <div className="card">
      <ul className="mastery-list">
        {player.masteries.map((m) => (
          <li key={m.champion_id} className="mastery-row">
            <ChampionAvatar champion={champs.get(m.champion_id)} id={m.champion_id} size={36} showName />
            <span className="mastery-row__lvl" title="Niveau de maîtrise">Niv. {m.level}</span>
            <div className="mastery-row__bar">
              <Bar value={m.points / max} label={`${m.points.toLocaleString('fr-FR')} points`} tone="blue" size="sm" />
            </div>
            <span className="mastery-row__pts">{m.points.toLocaleString('fr-FR')} pts</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecentTab({ player }: { player: Player }) {
  const champs = useChampionMap();
  const { games, roles, champions } = player.recent;
  if (!games) {
    return <EmptyState title="Aucune partie récente">{player.puuid ? 'Synchronise le joueur pour récupérer ses dernières parties.' : 'Joueur manuel : l’historique Riot n’est pas disponible.'}</EmptyState>;
  }
  const total = ROLES.reduce((s, r) => s + (roles[r] ?? 0), 0) || 1;
  return (
    <div className="stack-lg">
      <section className="card">
        <h3 className="card__title">Répartition des rôles · {games} parties</h3>
        <div className="role-dist" role="img" aria-label={ROLES.map((r) => `${ROLE_LABEL[r]} ${roles[r] ?? 0}`).join(', ')}>
          {ROLES.filter((r) => (roles[r] ?? 0) > 0).map((r) => (
            <span key={r} className={`role-dist__seg role-dist__seg--${r.toLowerCase()}`} style={{ width: `${((roles[r] ?? 0) / total) * 100}%` }} />
          ))}
        </div>
        <ul className="role-dist__legend">
          {ROLES.map((r) => (
            <li key={r}><span className={`dot dot--${r.toLowerCase()}`} />{ROLE_SHORT[r]} <strong>{roles[r] ?? 0}</strong></li>
          ))}
        </ul>
      </section>
      <section className="card">
        <h3 className="card__title">Champions joués</h3>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th scope="col">Champion</th><th scope="col">Parties</th><th scope="col">Victoires</th><th scope="col">KDA</th></tr>
            </thead>
            <tbody>
              {champions.map((c) => {
                const wr = c.games ? c.wins / c.games : 0;
                const kda = (c.kills + c.assists) / Math.max(1, c.deaths);
                return (
                  <tr key={c.champion_id}>
                    <td><span className="row-champ"><ChampionAvatar champion={champs.get(c.champion_id)} id={c.champion_id} size={28} showName />{c.role && <RoleBadge role={c.role} compact />}</span></td>
                    <td>{c.games}</td>
                    <td className={wr >= 0.5 ? 'pos' : 'neg'}>{Math.round(wr * 100)} %</td>
                    <td title={`${c.kills.toFixed(1)} / ${c.deaths.toFixed(1)} / ${c.assists.toFixed(1)}`}>
                      {kda.toFixed(2)}
                      <span className="muted small kda-detail"> ({c.kills.toFixed(1)}/{c.deaths.toFixed(1)}/{c.assists.toFixed(1)})</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export function PlayerPage() {
  const { id = '' } = useParams();
  const player = usePlayer(id);
  const sync = useSyncPlayer();
  const [tab, setTab] = useState<Tab>('prefs');

  if (player.isPending) {
    return (
      <div className="page" aria-busy="true">
        <div className="card"><Skeleton height={64} /></div>
        <div className="card"><Skeleton height={240} /></div>
      </div>
    );
  }
  if (player.isError) {
    return (
      <div className="page">
        <ErrorMessage error={player.error} onRetry={() => player.refetch()} />
        <Link to="/" className="btn btn--ghost">← Retour à l’équipe</Link>
      </div>
    );
  }
  const p = player.data;
  return (
    <div className="page">
      <Link to="/" className="back">← Équipe</Link>
      <header className="card player-head">
        <Avatar src={p.profile_icon_url} name={p.game_name} size={72} round />
        <div className="player-head__id">
          <h1>{p.game_name}<span className="tag">#{p.tag_line}</span></h1>
          <div className="player-card__meta">
            <span>{p.platform.toUpperCase()}</span>
            {p.summoner_level !== null && <span>Niv. {p.summoner_level}</span>}
            <span>{formatRank(p.rank)}</span>
            {p.rank && <span>{p.rank.wins}V / {p.rank.losses}D</span>}
            {!p.puuid && <Chip tone="muted">Joueur manuel</Chip>}
          </div>
          <p className="muted small">Dernière synchro : {formatDate(p.last_synced_at)}</p>
        </div>
        <div className="player-head__actions">
          <button type="button" className="btn btn--primary" onClick={() => sync.mutate(p.id)} disabled={sync.isPending || !p.puuid} title={!p.puuid ? 'Indisponible pour un joueur manuel' : undefined}>
            {sync.isPending ? 'Synchronisation…' : 'Synchroniser'}
          </button>
        </div>
      </header>
      {sync.isError && <ErrorMessage error={sync.error} />}

      <div className="tabs" role="tablist" aria-label="Sections du joueur">
        {TABS.map((t) => (
          <button
            key={t.key}
            id={`tab-${t.key}`}
            role="tab"
            type="button"
            aria-selected={tab === t.key}
            aria-controls={`panel-${t.key}`}
            className={`tab ${tab === t.key ? 'is-active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'prefs' && <PreferencesTab player={p} />}
        {tab === 'pool' && <PoolTab player={p} />}
        {tab === 'mastery' && <MasteryTab player={p} />}
        {tab === 'recent' && <RecentTab player={p} />}
      </div>
    </div>
  );
}

