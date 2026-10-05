import { useEffect, useId, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import { useChampionMap, usePlayers, useSaveComposition, useTeams, useThemes } from '../api/hooks';
import type { CompositionSuggestion, GenerationOptions, Pick, Role } from '../api/types';
import { ROLES } from '../api/types';
import { Avatar, ChampionAvatar } from '../components/ChampionAvatar';
import { ChampionPicker } from '../components/ChampionPicker';
import { CompositionCard } from '../components/CompositionCard';
import { GamePlanDrawer } from '../components/GamePlanView';
import { PromptModal } from '../components/Modal';
import { Chip, EmptyState, ErrorMessage, SkeletonCards, Spinner } from '../components/ui';
import { ROLE_LABEL, riotId } from '../lib/format';
import { loadLocal, saveLocal } from '../lib/storage';

const CUSTOM = '__custom__';

function toPicks(s: CompositionSuggestion): Pick[] {
  return s.picks.map(({ role, champion_id, player_id }) => ({ role, champion_id, player_id: player_id ?? null }));
}

function ChampionMultiPicker({ label, ids, onChange, max }: { label: string; ids: string[]; onChange: (ids: string[]) => void; max?: number }) {
  const champs = useChampionMap();
  const full = max !== undefined && ids.length >= max;
  return (
    <div className="stack-sm">
      <ChampionPicker label={label} exclude={ids} onSelect={(id) => onChange([...ids, id])} disabled={full} placeholder={full ? `Maximum ${max}` : undefined} />
      {ids.length > 0 && (
        <ul className="champ-chips">
          {ids.map((id) => (
            <li key={id} className="champ-chip">
              <ChampionAvatar champion={champs.get(id)} id={id} size={22} />
              <span>{champs.get(id)?.name ?? id}</span>
              <button type="button" className="icon-btn icon-btn--sm" onClick={() => onChange(ids.filter((x) => x !== id))} aria-label={`Retirer ${champs.get(id)?.name ?? id}`}>×</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CompositionsPage() {
  const players = usePlayers();
  const teams = useTeams();
  const themes = useThemes();
  const champs = useChampionMap();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const id = useId();

  const [source, setSource] = useState<string>(() => params.get('team') ?? loadLocal<string>('lastTeam', ''));
  const [customIds, setCustomIds] = useState<string[]>([]);
  const [theme, setTheme] = useState<string | null>(null);
  const [roleAssign, setRoleAssign] = useState<Record<string, Role>>({});
  const [locks, setLocks] = useState<Record<string, string>>({});
  const [bans, setBans] = useState<string[]>([]);
  const [enemies, setEnemies] = useState<string[]>([]);
  const [exploration, setExploration] = useState(0.2);
  const [count, setCount] = useState(5);
  const [planPicks, setPlanPicks] = useState<Pick[] | null>(null);
  const [planTitle, setPlanTitle] = useState('');
  const [toSave, setToSave] = useState<CompositionSuggestion | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const save = useSaveComposition();

  // Resolve the default source once teams are loaded.
  useEffect(() => {
    if (!teams.data) return;
    if (source === CUSTOM) return;
    if (!teams.data.some((t) => t.id === source)) setSource(teams.data[0]?.id ?? CUSTOM);
  }, [teams.data, source]);

  useEffect(() => {
    if (source && source !== CUSTOM) saveLocal('lastTeam', source);
  }, [source]);

  const team = teams.data?.find((t) => t.id === source);
  const playerIds = source === CUSTOM ? customIds : team?.player_ids ?? [];
  const playerMap = useMemo(() => new Map((players.data ?? []).map((p) => [p.id, p])), [players.data]);
  const selectedPlayers = playerIds.map((pid) => playerMap.get(pid)).filter((p) => !!p);

  const generate = useMutation({
    mutationFn: () => {
      const options: GenerationOptions = {
        theme,
        role_assignments: Object.fromEntries(Object.entries(roleAssign).filter(([pid]) => playerIds.includes(pid))),
        locked_picks: Object.fromEntries(Object.entries(locks).filter(([pid]) => playerIds.includes(pid))),
        bans,
        enemy_champions: enemies,
        count,
        exploration,
      };
      return api.generate({ player_ids: playerIds, options });
    },
  });

  const playstyle = themes.data?.filter((t) => t.kind === 'playstyle') ?? [];
  const thematic = themes.data?.filter((t) => t.kind === 'thematic') ?? [];
  const selectedTheme = themes.data?.find((t) => t.key === theme);
  const loading = players.isPending || teams.isPending;

  if (!loading && players.data && players.data.length === 0) {
    return (
      <div className="page">
        <header className="page__head"><h1>Compositions</h1></header>
        <EmptyState title="Ajoute d’abord tes amis" action={<Link to="/" className="btn btn--primary">Aller à l’équipe</Link>}>
          Il faut au moins un joueur pour générer des compositions.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page__head">
        <h1>Compositions</h1>
        <p className="lead">Choisis qui joue et un thème : on propose les meilleures compos selon ce que chacun sait et veut jouer.</p>
      </header>

      {(players.isError || teams.isError || themes.isError) && (
        <ErrorMessage error={players.error ?? teams.error ?? themes.error} onRetry={() => { players.refetch(); teams.refetch(); themes.refetch(); }} />
      )}

      <form
        className="card stack-lg"
        onSubmit={(e) => {
          e.preventDefault();
          if (playerIds.length) generate.mutate();
        }}
      >
        <div className="field">
          <label htmlFor={`${id}-source`} className="field__label">Joueurs</label>
          {loading ? (
            <span className="skeleton" style={{ height: 40, width: '100%' }} />
          ) : (
            <select id={`${id}-source`} className="input" value={source} onChange={(e) => setSource(e.target.value)}>
              {teams.data?.map((t) => <option key={t.id} value={t.id}>Équipe : {t.name} ({t.player_ids.length})</option>)}
              <option value={CUSTOM}>Choisir 1 à 5 joueurs…</option>
            </select>
          )}
        </div>

        {source === CUSTOM && players.data && (
          <fieldset className="fieldset">
            <legend className="field__label">Sélection ({customIds.length}/5)</legend>
            <div className="chips">
              {players.data.map((p) => {
                const on = customIds.includes(p.id);
                return (
                  <Chip
                    key={p.id}
                    selected={on}
                    disabled={!on && customIds.length >= 5}
                    onClick={() => setCustomIds((c) => (on ? c.filter((x) => x !== p.id) : [...c, p.id]))}
                  >
                    <Avatar src={p.profile_icon_url} name={p.game_name} size={20} round /> {p.game_name}
                  </Chip>
                );
              })}
            </div>
          </fieldset>
        )}

        {source !== CUSTOM && team && (
          <div className="member-row" aria-label="Joueurs de l’équipe">
            {selectedPlayers.map((p) => (
              <span key={p.id} className="member" title={riotId(p)}>
                <Avatar src={p.profile_icon_url} name={p.game_name} size={24} round />
                <span>{p.game_name}</span>
              </span>
            ))}
            {selectedPlayers.length === 0 && <span className="muted small">Cette équipe n’a aucun joueur. <Link to="/">Modifier l’équipe</Link></span>}
          </div>
        )}

        <fieldset className="fieldset">
          <legend className="field__label">Thème</legend>
          {themes.isPending ? (
            <span className="skeleton" style={{ height: 34, width: '100%' }} />
          ) : (
            <div className="theme-groups">
              <div className="chips">
                <Chip selected={theme === null} onClick={() => setTheme(null)} tone="gold">★ Automatique (meilleures options)</Chip>
              </div>
              {playstyle.length > 0 && (
                <div className="theme-group">
                  <h3 className="theme-group__title">Styles de jeu</h3>
                  <div className="chips">
                    {playstyle.map((t) => <Chip key={t.key} selected={theme === t.key} onClick={() => setTheme(t.key)} title={t.description}>{t.label}</Chip>)}
                  </div>
                </div>
              )}
              {thematic.length > 0 && (
                <div className="theme-group">
                  <h3 className="theme-group__title">Thèmes fun</h3>
                  <div className="chips">
                    {thematic.map((t) => <Chip key={t.key} selected={theme === t.key} onClick={() => setTheme(t.key)} title={t.description}>{t.label}</Chip>)}
                  </div>
                </div>
              )}
              <p className="hint" aria-live="polite">
                {selectedTheme ? selectedTheme.description : 'On teste tous les thèmes et on garde les meilleurs pour ton groupe.'}
              </p>
            </div>
          )}
        </fieldset>

        <details className="details advanced">
          <summary>Options avancées</summary>
          <div className="stack-lg advanced__body">
            {selectedPlayers.length > 0 && (
              <div className="stack-sm">
                <h3 className="sub">Par joueur</h3>
                <ul className="per-player">
                  {selectedPlayers.map((p) => (
                    <li key={p.id} className="per-player__row">
                      <span className="member"><Avatar src={p.profile_icon_url} name={p.game_name} size={24} round /> <span>{p.game_name}</span></span>
                      <div className="field">
                        <label className="field__label" htmlFor={`${id}-role-${p.id}`}>Rôle imposé</label>
                        <select
                          id={`${id}-role-${p.id}`}
                          className="input"
                          value={roleAssign[p.id] ?? ''}
                          onChange={(e) => setRoleAssign((r) => {
                            const next = { ...r };
                            if (e.target.value) next[p.id] = e.target.value as Role;
                            else delete next[p.id];
                            return next;
                          })}
                        >
                          <option value="">Automatique</option>
                          {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                        </select>
                      </div>
                      <ChampionPicker
                        label="Champion verrouillé"
                        value={locks[p.id] ?? null}
                        role={roleAssign[p.id] ?? null}
                        onSelect={(cid) => setLocks((l) => ({ ...l, [p.id]: cid }))}
                        onClear={() => setLocks((l) => {
                          const next = { ...l };
                          delete next[p.id];
                          return next;
                        })}
                        placeholder="Aucun (libre)"
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="two-cols">
              <ChampionMultiPicker label="Bannissements" ids={bans} onChange={setBans} max={10} />
              <ChampionMultiPicker label="Champions adverses (optionnel)" ids={enemies} onChange={setEnemies} max={5} />
            </div>
            <div className="two-cols">
              <div className="field">
                <label htmlFor={`${id}-explo`} className="field__label">Exploration</label>
                <input
                  id={`${id}-explo`}
                  type="range"
                  className="range"
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(exploration * 100)}
                  onChange={(e) => setExploration(Number(e.target.value) / 100)}
                  aria-valuetext={`${Math.round(exploration * 100)} %`}
                />
                <div className="range-labels"><span>Rester sur nos champions</span><span>Découvrir de nouveaux champions</span></div>
              </div>
              <div className="field">
                <label htmlFor={`${id}-count`} className="field__label">Nombre de résultats</label>
                <input
                  id={`${id}-count`}
                  type="number"
                  className="input input--narrow"
                  min={1}
                  max={20}
                  value={count}
                  onChange={(e) => setCount(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                />
              </div>
            </div>
          </div>
        </details>

        <div className="row row--end">
          {playerIds.length === 0 && !loading && <span className="muted small">Sélectionne au moins un joueur.</span>}
          <button type="submit" className="btn btn--primary btn--lg" disabled={!playerIds.length || generate.isPending}>
            {generate.isPending ? <><Spinner label="Génération" /> Génération…</> : 'Générer les compositions'}
          </button>
        </div>
      </form>

      <section className="section" aria-live="polite" aria-busy={generate.isPending}>
        {generate.isError && <ErrorMessage error={generate.error} onRetry={() => generate.mutate()} />}
        {savedMsg && <p className="ok" role="status">{savedMsg} <Link to="/saved">Voir les sauvegardées</Link></p>}
        {generate.isPending && <SkeletonCards count={2} height={320} />}
        {generate.data && !generate.isPending && generate.data.suggestions.length === 0 && (
          <EmptyState title="Aucune composition trouvée">
            Essaie le thème « Automatique », augmente l’exploration ou retire des contraintes (rôles imposés, bannissements).
          </EmptyState>
        )}
        {generate.data && !generate.isPending && generate.data.suggestions.length > 0 && (
          <div className="comp-grid">
            {generate.data.suggestions.map((s, i) => (
              <CompositionCard
                key={`${s.theme}-${i}`}
                rank={i + 1}
                suggestion={s}
                champions={champs}
                players={playerMap}
                onPlan={() => {
                  setPlanTitle(`Plan de jeu · ${s.theme_label}`);
                  setPlanPicks(toPicks(s));
                }}
                onMatchup={() => navigate('/matchup', { state: { ally: toPicks(s), enemy: enemies, label: s.theme_label } })}
                onSave={() => {
                  save.reset();
                  setToSave(s);
                }}
              />
            ))}
          </div>
        )}
        {!generate.data && !generate.isPending && !generate.isError && (
          <EmptyState title="Prêt à composer" icon="⚔">Choisis tes joueurs et un thème, puis clique sur « Générer les compositions ».</EmptyState>
        )}
      </section>

      <GamePlanDrawer picks={planPicks} title={planTitle} onClose={() => setPlanPicks(null)} />
      <PromptModal
        open={!!toSave}
        title="Sauvegarder la composition"
        label="Nom de la composition"
        initial={toSave ? `${toSave.theme_label}${team ? ` · ${team.name}` : ''}` : ''}
        confirmLabel="Sauvegarder"
        pending={save.isPending}
        error={save.isError ? <ErrorMessage error={save.error} /> : null}
        onCancel={() => setToSave(null)}
        onConfirm={(name) => {
          if (!toSave) return;
          save.mutate(
            { name, team_id: team?.id ?? null, theme: toSave.theme, picks: toPicks(toSave) },
            {
              onSuccess: () => {
                setToSave(null);
                setSavedMsg(`« ${name} » sauvegardée.`);
              },
            },
          );
        }}
      />
    </div>
  );
}
