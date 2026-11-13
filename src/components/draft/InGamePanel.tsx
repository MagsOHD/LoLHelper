import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { overallProgress, type ProfileStatus } from '../../api/enemyProfile';
import { useChampionMap } from '../../api/hooks';
import type { DraftEnemyAccount, DraftState, EnemyPlayerProfile, Pick } from '../../api/types';
import { guessEnemyRoles } from '../../engine';
import { formatRank } from '../../lib/format';
import { MatchupPlanView } from '../../pages/MatchupPage';
import { ChampionAvatar } from '../ChampionAvatar';
import { Chip, ErrorMessage, Skeleton, Spinner } from '../ui';
import { AttentionCard, EnemyPlayersCard, EnemyProfilesList } from './EnemyIntel';

const ONE_TRICK_POINTS = 300_000;

function masteryText(a: DraftEnemyAccount): string | null {
  const m = a.champion_mastery;
  if (!m) return null;
  const k = m.points >= 1000 ? `${Math.round(m.points / 1000)}k` : String(m.points);
  return `Maîtrise ${m.level} · ${k} points`;
}

function EnemyAccounts({ accounts }: { accounts: DraftEnemyAccount[] }) {
  const champs = useChampionMap();
  return (
    <ul className="accounts">
      {accounts.map((a) => {
        const top = a.masteries?.[0];
        const oneTrick = (a.champion_mastery?.points ?? 0) >= ONE_TRICK_POINTS || (top && top.champion_id === a.champion_id && top.points >= ONE_TRICK_POINTS / 2);
        return (
          <li key={a.puuid || a.champion_id} className="account">
            <ChampionAvatar champion={champs.get(a.champion_id)} id={a.champion_id} size={36} />
            <div className="account__main">
              <strong className="account__id">{a.riot_id || 'Joueur inconnu'}</strong>
              <span className="small muted">{champs.get(a.champion_id)?.name ?? a.champion_id} · {formatRank(a.rank ?? null)}</span>
              {masteryText(a) && <span className="small">{masteryText(a)}</span>}
            </div>
            {oneTrick && <Chip tone="red">Spécialiste</Chip>}
          </li>
        );
      })}
    </ul>
  );
}

/** In-game view: enemy accounts (known only now), their profiles, and the plan against the enemy team. */
export function InGamePanel({ draft, profiles, statuses }: { draft: DraftState; profiles: EnemyPlayerProfile[]; statuses: ProfileStatus[] }) {
  const champs = useChampionMap();
  const allyFilled = draft.ally.filter((s) => s.champion_id);
  const enemyFilled = draft.enemy.filter((s) => s.champion_id);
  const complete = allyFilled.length === 5 && enemyFilled.length === 5;
  const roles = guessEnemyRoles(allyFilled.map((s) => ({ champion_id: s.champion_id as string, role: s.role ?? null })), { get: (id) => champs.get(id) });
  const ally: Pick[] = allyFilled.map((s, i) => ({ role: roles[i] ?? 'MID', champion_id: s.champion_id as string, player_id: s.player_id ?? null }));
  const enemy = enemyFilled.map((s) => ({ champion_id: s.champion_id as string, ...(s.role ? { role: s.role } : {}) }));
  // Profiles arrive one by one: the plan is recomputed (previous one kept on screen meanwhile).
  const key = JSON.stringify([ally, enemy, profiles.map((p) => [p.puuid, p.fetched_at, p.champion_id, p.role])]);
  const plan = useQuery({
    queryKey: ['draft-matchup', key],
    queryFn: () => api.matchup({ ally, enemy, ...(profiles.length ? { enemy_profiles: profiles } : {}) }),
    enabled: complete && champs.size > 0,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
  const progress = overallProgress(statuses);
  const insights = plan.data?.enemy_players ?? [];
  const failed = statuses.filter((s) => s.state === 'error').length;
  // Accounts without a detailed insight (profile unavailable) stay listed.
  const rest = (draft.enemy_accounts ?? []).filter((a) => !insights.some((i) => i.puuid === a.puuid));
  return (
    <section className="section ingame" aria-labelledby="ingame-title">
      <div className="card card--enemy">
        <h2 id="ingame-title" className="card__title">Partie en cours — équipe adverse</h2>
        <div aria-live="polite" className="ingame__progress">
          {progress.loading > 0 && (
            <p className="small muted">
              <Spinner label="Profils adverses en chargement" /> Profils adverses : {profiles.length} chargé{profiles.length > 1 ? 's' : ''},
              {' '}{progress.loading} en cours ({progress.calls}/{progress.total} appels Riot)
            </p>
          )}
          {failed > 0 && progress.loading === 0 && <p className="small muted">{failed} profil{failed > 1 ? 's' : ''} indisponible{failed > 1 ? 's' : ''} (limite Riot ou compte introuvable).</p>}
        </div>
        {rest.length > 0 ? <EnemyAccounts accounts={rest} /> : !insights.length && <p className="muted small">Comptes adverses indisponibles.</p>}
        {insights.length > 0 && <p className="small muted">Profils détaillés et plan ci-dessous.</p>}
        {insights.length === 0 && profiles.length > 0 && (
          <div className="ingame__profiles">
            <h3 className="sub">Profils récents</h3>
            <EnemyProfilesList profiles={profiles} insights={[]} />
          </div>
        )}
      </div>
      {complete ? (
        <div className="stack">
          <h2>Plan contre l’équipe adverse</h2>
          {plan.isPending && <div className="stack" aria-busy="true"><Skeleton height={120} /><Skeleton height={180} /></div>}
          {plan.isError && <ErrorMessage error={plan.error} onRetry={() => plan.refetch()} />}
          {plan.data && (
            <>
              <EnemyPlayersCard insights={insights} profiles={profiles} title="Joueurs adverses" />
              <AttentionCard attention={plan.data.attention ?? []} />
              <MatchupPlanView plan={plan.data} />
            </>
          )}
        </div>
      ) : (
        <p className="muted small">Le plan de jeu s’affiche quand les 10 champions sont connus.</p>
      )}
    </section>
  );
}
