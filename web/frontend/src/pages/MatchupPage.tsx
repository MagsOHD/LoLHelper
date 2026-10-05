import { useEffect, useId, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import { useChampionMap, usePlayers, useSaved, useThemeLabels } from '../api/hooks';
import type { EnemyPick, MatchupPlan, Pick, Role } from '../api/types';
import { ROLES } from '../api/types';
import { ChampionAvatar } from '../components/ChampionAvatar';
import { ChampionPicker } from '../components/ChampionPicker';
import { GamePlanDrawer } from '../components/GamePlanView';
import { BulletList, Chip, EmptyState, ErrorMessage, Pips, RoleBadge, Skeleton, Spinner } from '../components/ui';
import { ROLE_LABEL } from '../lib/format';

interface AllySlot { champion_id: string | null; player_id: string | null }
interface EnemySlot { champion_id: string | null; role: Role | '' }
interface NavState { ally?: Pick[]; enemy?: string[]; label?: string }

const emptyAlly = (): Record<Role, AllySlot> =>
  Object.fromEntries(ROLES.map((r) => [r, { champion_id: null, player_id: null }])) as Record<Role, AllySlot>;
const emptyEnemy = (): EnemySlot[] => ROLES.map(() => ({ champion_id: null, role: '' }));

function allyFromPicks(picks: Pick[]): Record<Role, AllySlot> {
  const a = emptyAlly();
  for (const p of picks) a[p.role] = { champion_id: p.champion_id, player_id: p.player_id ?? null };
  return a;
}

export function MatchupPlanView({ plan }: { plan: MatchupPlan }) {
  const champs = useChampionMap();
  const themeLabel = useThemeLabels();
  const name = (id: string) => champs.get(id)?.name ?? id;
  return (
    <div className="plan">
      <div className="card card--enemy">
        <h3 className="card__title">L’équipe adverse</h3>
        <p className="plan__identity">{plan.enemy_identity}</p>
        {plan.enemy_themes.length > 0 && (
          <div className="chips">{plan.enemy_themes.map((t) => <Chip key={t} tone="red">{themeLabel(t)}</Chip>)}</div>
        )}
        <h4 className="sub">Leurs conditions de victoire</h4>
        <BulletList items={plan.enemy_win_conditions} />
      </div>

      <div className="card card--ally">
        <h3 className="card__title">Comment gagner</h3>
        <BulletList items={plan.how_to_win} tone="green" />
      </div>

      <div className="card">
        <h3 className="card__title">Menaces</h3>
        {plan.threats.length === 0 ? <p className="muted">Aucune menace particulière.</p> : (
          <ul className="threats">
            {[...plan.threats].sort((a, b) => b.danger - a.danger).map((t) => (
              <li key={t.champion_id} className="threat">
                <div className="threat__head">
                  <ChampionAvatar champion={champs.get(t.champion_id)} id={t.champion_id} size={36} showName />
                  <Pips value={t.danger} label="Danger" />
                </div>
                <p><strong>Pourquoi :</strong> {t.why}</p>
                <p><strong>Comment gérer :</strong> {t.how_to_handle}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {plan.lane_matchups.length > 0 && (
        <div className="card">
          <h3 className="card__title">Face-à-face par lane</h3>
          <ul className="lanes">
            {plan.lane_matchups.map((m) => (
              <li key={m.role} className="lane">
                <RoleBadge role={m.role} />
                <div className="lane__vs">
                  <span className="lane__ally"><ChampionAvatar champion={champs.get(m.ally_champion_id)} id={m.ally_champion_id} size={28} /> {name(m.ally_champion_id)}</span>
                  <span className="lane__sep" aria-label="contre">vs</span>
                  <span className="lane__enemy"><ChampionAvatar champion={champs.get(m.enemy_champion_id)} id={m.enemy_champion_id} size={28} /> {name(m.enemy_champion_id)}</span>
                </div>
                <p className="lane__advice">{m.advice}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="two-cols">
        <div className="card">
          <h3 className="card__title">Objectifs</h3>
          <BulletList items={plan.objectives} />
        </div>
        <div className="card">
          <h3 className="card__title">Bannissements conseillés</h3>
          {plan.suggested_bans.length === 0 ? <p className="muted">—</p> : (
            <div className="ban-row">
              {plan.suggested_bans.map((id) => <ChampionAvatar key={id} champion={champs.get(id)} id={id} size={36} showName />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function MatchupPage() {
  const location = useLocation();
  const [params] = useSearchParams();
  const savedId = params.get('saved');
  const saved = useSaved();
  const players = usePlayers();
  const nav = (location.state ?? {}) as NavState;
  const id = useId();

  const [ally, setAlly] = useState<Record<Role, AllySlot>>(() => (nav.ally ? allyFromPicks(nav.ally) : emptyAlly()));
  const [enemy, setEnemy] = useState<EnemySlot[]>(() => {
    const e = emptyEnemy();
    (nav.enemy ?? []).slice(0, 5).forEach((cid, i) => { e[i].champion_id = cid; });
    return e;
  });
  const [label, setLabel] = useState<string | undefined>(nav.label);
  const [showPlan, setShowPlan] = useState(false);

  // Pre-fill from a saved composition (?saved=id).
  useEffect(() => {
    if (!savedId || !saved.data) return;
    const s = saved.data.find((x) => x.id === savedId);
    if (s) {
      setAlly(allyFromPicks(s.picks));
      setLabel(s.name);
    }
  }, [savedId, saved.data]);

  const playerName = useMemo(() => {
    const m = new Map((players.data ?? []).map((p) => [p.id, p.game_name]));
    return (pid: string | null) => (pid ? m.get(pid) : undefined);
  }, [players.data]);

  const allyPicks: Pick[] = ROLES.filter((r) => ally[r].champion_id).map((r) => ({ role: r, champion_id: ally[r].champion_id!, player_id: ally[r].player_id }));
  const enemyPicks: EnemyPick[] = enemy.filter((e) => e.champion_id).map((e) => ({ champion_id: e.champion_id!, ...(e.role ? { role: e.role } : {}) }));
  const usedIds = [...allyPicks.map((p) => p.champion_id), ...enemyPicks.map((p) => p.champion_id)];

  const matchup = useMutation({ mutationFn: () => api.matchup({ ally: allyPicks, enemy: enemyPicks }) });

  const canSubmit = allyPicks.length > 0 && enemyPicks.length > 0;

  return (
    <div className="page">
      <header className="page__head">
        <h1>Matchup</h1>
        <p className="lead">Indique ta compo et celle d’en face : on te dit comment jouer contre eux.{label && <> Compo : <strong>{label}</strong>.</>}</p>
      </header>

      {savedId && saved.isPending && <Skeleton height={40} />}
      {saved.isError && savedId && <ErrorMessage error={saved.error} />}

      <form
        className="vs-grid"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) matchup.mutate();
        }}
      >
        <fieldset className="card card--ally vs-side">
          <legend className="vs-side__title">Notre équipe</legend>
          <ul className="slots">
            {ROLES.map((r) => (
              <li key={r} className="slot">
                <RoleBadge role={r} />
                <div className="slot__picker">
                  <ChampionPicker
                    label={`Notre ${ROLE_LABEL[r]}`}
                    hideLabel
                    value={ally[r].champion_id}
                    role={r}
                    exclude={usedIds}
                    onSelect={(cid) => setAlly((a) => ({ ...a, [r]: { ...a[r], champion_id: cid } }))}
                    onClear={() => setAlly((a) => ({ ...a, [r]: { champion_id: null, player_id: null } }))}
                    placeholder="Choisir…"
                  />
                  {playerName(ally[r].player_id) && <span className="slot__player">Joué par {playerName(ally[r].player_id)}</span>}
                </div>
              </li>
            ))}
          </ul>
          {allyPicks.length > 0 && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowPlan(true)}>Voir notre plan de jeu</button>
          )}
        </fieldset>

        <fieldset className="card card--enemy vs-side">
          <legend className="vs-side__title">Équipe adverse</legend>
          <ul className="slots">
            {enemy.map((e, i) => (
              <li key={i} className="slot slot--enemy">
                <span className="slot__num" aria-hidden="true">{i + 1}</span>
                <div className="slot__picker">
                  <ChampionPicker
                    label={`Adversaire ${i + 1}`}
                    hideLabel
                    value={e.champion_id}
                    role={e.role || null}
                    exclude={usedIds}
                    onSelect={(cid) => setEnemy((en) => en.map((x, j) => (j === i ? { ...x, champion_id: cid } : x)))}
                    onClear={() => setEnemy((en) => en.map((x, j) => (j === i ? { champion_id: null, role: '' } : x)))}
                    placeholder="Champion adverse…"
                  />
                </div>
                <label className="sr-only" htmlFor={`${id}-erole-${i}`}>Rôle de l’adversaire {i + 1}</label>
                <select
                  id={`${id}-erole-${i}`}
                  className="input input--role"
                  value={e.role}
                  onChange={(ev) => setEnemy((en) => en.map((x, j) => (j === i ? { ...x, role: ev.target.value as Role | '' } : x)))}
                >
                  <option value="">Rôle ?</option>
                  {ROLES.map((r) => <option key={r} value={r}>{r === 'BOTTOM' ? 'ADC' : r === 'JUNGLE' ? 'JGL' : r === 'SUPPORT' ? 'SUP' : r}</option>)}
                </select>
              </li>
            ))}
          </ul>
          <p className="hint">Le rôle est optionnel : il sera deviné s’il est vide.</p>
        </fieldset>

        <div className="vs-actions">
          {!canSubmit && <span className="muted small">Ajoute au moins un champion de chaque côté.</span>}
          <button type="button" className="btn btn--ghost" onClick={() => { setAlly(emptyAlly()); setEnemy(emptyEnemy()); setLabel(undefined); matchup.reset(); }}>
            Tout effacer
          </button>
          <button type="submit" className="btn btn--primary btn--lg" disabled={!canSubmit || matchup.isPending}>
            {matchup.isPending ? <><Spinner label="Analyse" /> Analyse…</> : 'Analyser le matchup'}
          </button>
        </div>
      </form>

      <section className="section" aria-live="polite">
        {matchup.isError && <ErrorMessage error={matchup.error} onRetry={() => matchup.mutate()} />}
        {matchup.isPending && (
          <div className="stack" aria-busy="true"><Skeleton height={120} /><Skeleton height={200} /></div>
        )}
        {matchup.data && !matchup.isPending && <MatchupPlanView plan={matchup.data} />}
        {!matchup.data && !matchup.isPending && !matchup.isError && (
          <EmptyState title="Pas encore d’analyse" icon="⚔">
            Remplis les deux équipes puis lance l’analyse. Tu peux aussi partir d’une compo <Link to="/compositions">générée</Link> ou <Link to="/saved">sauvegardée</Link>.
          </EmptyState>
        )}
      </section>

      <GamePlanDrawer picks={showPlan ? allyPicks : null} title="Notre plan de jeu" onClose={() => setShowPlan(false)} />
    </div>
  );
}
