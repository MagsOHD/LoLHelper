import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useChampionMap } from '../../api/hooks';
import type { DraftEnemyAccount, DraftState, Pick } from '../../api/types';
import { guessEnemyRoles } from '../../engine';
import { formatRank } from '../../lib/format';
import { MatchupPlanView } from '../../pages/MatchupPage';
import { ChampionAvatar } from '../ChampionAvatar';
import { Chip, ErrorMessage, Skeleton } from '../ui';

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

/** In-game view: enemy accounts (known only now) and the plan against the enemy team. */
export function InGamePanel({ draft }: { draft: DraftState }) {
  const champs = useChampionMap();
  const allyFilled = draft.ally.filter((s) => s.champion_id);
  const enemyFilled = draft.enemy.filter((s) => s.champion_id);
  const complete = allyFilled.length === 5 && enemyFilled.length === 5;
  const roles = guessEnemyRoles(allyFilled.map((s) => ({ champion_id: s.champion_id as string, role: s.role ?? null })), { get: (id) => champs.get(id) });
  const ally: Pick[] = allyFilled.map((s, i) => ({ role: roles[i] ?? 'MID', champion_id: s.champion_id as string, player_id: s.player_id ?? null }));
  const enemy = enemyFilled.map((s) => ({ champion_id: s.champion_id as string, ...(s.role ? { role: s.role } : {}) }));
  const key = JSON.stringify([ally, enemy]);
  const plan = useQuery({
    queryKey: ['draft-matchup', key],
    queryFn: () => api.matchup({ ally, enemy }),
    enabled: complete && champs.size > 0,
    staleTime: Infinity,
  });
  return (
    <section className="section ingame" aria-labelledby="ingame-title">
      <div className="card card--enemy">
        <h2 id="ingame-title" className="card__title">Partie en cours — équipe adverse</h2>
        {draft.enemy_accounts?.length ? <EnemyAccounts accounts={draft.enemy_accounts} /> : <p className="muted small">Comptes adverses indisponibles.</p>}
      </div>
      {complete ? (
        <div className="stack">
          <h2>Plan contre l’équipe adverse</h2>
          {plan.isPending && <div className="stack" aria-busy="true"><Skeleton height={120} /><Skeleton height={180} /></div>}
          {plan.isError && <ErrorMessage error={plan.error} onRetry={() => plan.refetch()} />}
          {plan.data && <MatchupPlanView plan={plan.data} />}
        </div>
      ) : (
        <p className="muted small">Le plan de jeu s’affiche quand les 10 champions sont connus.</p>
      )}
    </section>
  );
}
