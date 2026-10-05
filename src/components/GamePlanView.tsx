import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useChampionMap, useThemeLabels } from '../api/hooks';
import type { GamePlan, Pick } from '../api/types';
import { PHASE_LABEL } from '../lib/format';
import { ChampionAvatar } from './ChampionAvatar';
import { Modal } from './Modal';
import { BulletList, Chip, ErrorMessage, RoleBadge, Skeleton } from './ui';

const DMG_LABEL: Record<string, string> = { AD: 'Physique (AD)', AP: 'Magique (AP)', MIXED: 'Mixte' };

export function DamageProfile({ profile }: { profile: Record<string, number> }) {
  const keys = ['AD', 'AP', 'MIXED'].filter((k) => (profile[k] ?? 0) > 0);
  const total = keys.reduce((s, k) => s + (profile[k] ?? 0), 0) || 1;
  return (
    <div className="dmg">
      <div className="dmg__bar" role="img" aria-label={keys.map((k) => `${DMG_LABEL[k]} ${Math.round(((profile[k] ?? 0) / total) * 100)} %`).join(', ')}>
        {keys.map((k) => (
          <span key={k} className={`dmg__seg dmg__seg--${k.toLowerCase()}`} style={{ width: `${((profile[k] ?? 0) / total) * 100}%` }} />
        ))}
      </div>
      <ul className="dmg__legend">
        {keys.map((k) => (
          <li key={k}><span className={`dot dot--${k.toLowerCase()}`} />{DMG_LABEL[k]} · {Math.round(((profile[k] ?? 0) / total) * 100)} %</li>
        ))}
      </ul>
    </div>
  );
}

export function GamePlanContent({ plan }: { plan: GamePlan }) {
  const champs = useChampionMap();
  const themeLabel = useThemeLabels();
  const phases = [...plan.phases].sort((a, b) => ['early', 'mid', 'late'].indexOf(a.phase) - ['early', 'mid', 'late'].indexOf(b.phase));
  return (
    <div className="plan">
      <p className="plan__identity">{plan.identity}</p>
      {plan.detected_themes.length > 0 && (
        <div className="chips" aria-label="Thèmes détectés">
          {plan.detected_themes.map((t, i) => <Chip key={t} tone={i === 0 ? 'gold' : 'muted'}>{themeLabel(t)}</Chip>)}
        </div>
      )}

      <section className="plan__block">
        <h3>Conditions de victoire</h3>
        <BulletList items={plan.win_conditions} tone="green" />
      </section>

      <section className="plan__block">
        <h3>Déroulé de la partie</h3>
        <ol className="timeline">
          {phases.map((p) => (
            <li key={p.phase} className={`timeline__item timeline__item--${p.phase}`}>
              <h4>{PHASE_LABEL[p.phase] ?? p.phase}</h4>
              <p>{p.summary}</p>
              {p.tips.length > 0 && <BulletList items={p.tips} />}
            </li>
          ))}
        </ol>
      </section>

      <div className="plan__cols">
        <section className="plan__block">
          <h3>Pics de puissance</h3>
          <BulletList items={plan.power_spikes} />
        </section>
        <section className="plan__block">
          <h3>Combos clés</h3>
          <BulletList items={plan.key_combos} />
        </section>
        <section className="plan__block">
          <h3>Objectifs</h3>
          <BulletList items={plan.objectives} />
        </section>
        <section className="plan__block">
          <h3>Profil de dégâts</h3>
          <DamageProfile profile={plan.damage_profile} />
        </section>
      </div>

      <section className="plan__block">
        <h3>Conseils par rôle</h3>
        <ul className="role-tips">
          {plan.role_tips.map((t) => (
            <li key={`${t.role}-${t.champion_id}`} className="role-tip">
              <div className="role-tip__head">
                <RoleBadge role={t.role} />
                <ChampionAvatar champion={champs.get(t.champion_id)} id={t.champion_id} size={28} showName />
              </div>
              <BulletList items={t.tips} />
            </li>
          ))}
        </ul>
      </section>

      <section className="plan__block">
        <h3>À éviter</h3>
        <BulletList items={plan.avoid} tone="red" />
      </section>
    </div>
  );
}

export function GamePlanLoader({ picks }: { picks: Pick[] }) {
  const key = picks.map((p) => `${p.role}:${p.champion_id}:${p.player_id ?? ''}`).join('|');
  const q = useQuery({
    queryKey: ['game-plan', key],
    queryFn: () => api.gamePlan(picks.map(({ role, champion_id, player_id }) => ({ role, champion_id, player_id: player_id ?? null }))),
    enabled: picks.length > 0,
    staleTime: 5 * 60_000,
  });
  if (q.isPending) {
    return (
      <div className="stack" aria-busy="true">
        <Skeleton height={20} width="80%" />
        <Skeleton height={90} />
        <Skeleton height={140} />
        <Skeleton height={90} />
      </div>
    );
  }
  if (q.isError) return <ErrorMessage error={q.error} onRetry={() => q.refetch()} />;
  return <GamePlanContent plan={q.data} />;
}

export function GamePlanDrawer({ picks, title, onClose }: { picks: Pick[] | null; title?: string; onClose: () => void }) {
  return (
    <Modal open={!!picks} onClose={onClose} title={title ?? 'Plan de jeu'} variant="drawer">
      {picks && <GamePlanLoader picks={picks} />}
    </Modal>
  );
}
