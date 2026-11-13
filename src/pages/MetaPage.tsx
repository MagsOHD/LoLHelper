import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useChampionMap, useMeta, usePlayers } from '../api/hooks';
import { refreshMetaEverywhere, useAdviceTier, useMetaCollection, useMetaStats, useMetaStatus, useTierOverride } from '../api/metaHooks';
import { useRiotLimits } from '../api/clashHooks';
import { MOCK_MODE } from '../api/client';
import { patchOptions, resolvePatch } from '../api/metaTier';
import { formatWindow, tierLabel } from '../api/metaRank';
import type { MetaTier, Role } from '../api/types';
import { META_MIN_GAMES } from '../engine/meta';
import { formatDate } from '../lib/format';
import { CollectPanel } from '../components/meta/CollectPanel';
import { RankTierPanel } from '../components/meta/RankTierPanel';
import { TierTable } from '../components/meta/TierTable';
import { ChampionMetaDrawer } from '../components/meta/ChampionMetaDrawer';
import { fmtInt } from '../components/meta/format';
import { EmptyState, ErrorMessage, Skeleton } from '../components/ui';

export function MetaPage() {
  const id = useId();
  const qc = useQueryClient();
  const app = useMeta();
  const status = useMetaStatus();
  const progress = useMetaCollection();
  const champs = useChampionMap();
  const players = usePlayers();
  const looping = progress.phase === 'running' || progress.phase === 'waiting' || progress.phase === 'stopping';
  const keyLimits = useRiotLimits(MOCK_MODE || Boolean(app.data?.riot_configured), looping || Boolean(status.data?.collecting));

  // Tier of the advice for all the friends (median solo rank, or the override).
  const ranks = useMemo(() => (players.data ?? []).map((p) => p.rank), [players.data]);
  const choice = useAdviceTier(ranks);
  const [override, setOverride] = useTierOverride();

  const tiers = status.data?.tiers ?? [];
  const [selectedTier, setSelectedTier] = useState<MetaTier | null>(null);
  const viewTier: MetaTier | null = tiers.length ? selectedTier ?? choice?.tier ?? 'MASTER_PLUS' : null;
  // Wait for the tier list (and the friends' ranks) so the default tier is fetched only once.
  const ready = !status.isPending && (selectedTier !== null || !players.isPending);

  const served = app.data?.meta_stats ?? null;
  const options = useMemo(() => patchOptions(status.data?.patches ?? [], served), [status.data?.patches, served]);
  const [selected, setSelected] = useState<string | null>(null);
  const patch = resolvePatch(selected, options);
  const stats = useMetaStats(patch, viewTier, ready);
  const meta = stats.data ?? null;
  const loading = !ready || stats.isLoading;

  const [open, setOpen] = useState<{ id: string; role: Role } | null>(null);

  // A pass finished elsewhere (hourly cron, another tab): refresh the snapshots once.
  const lastAt = status.data?.last_run?.at ?? null;
  const seenAt = useRef<string | null>(null);
  useEffect(() => {
    if (!lastAt) return;
    if (seenAt.current && seenAt.current !== lastAt && !looping) refreshMetaEverywhere(qc);
    seenAt.current = lastAt;
  }, [lastAt, looping, qc]);

  const platform = (meta?.platform || app.data?.platform || '').toUpperCase();
  const selectValue = selected ?? meta?.patch ?? served?.patch ?? options[0]?.value ?? '';
  const noMeta = !loading && !stats.isError && !meta;
  const shownTier = meta?.tier ?? viewTier;
  const hours = status.data?.window ?? null;

  return (
    <div className="page meta-page">
      <header className="meta-head">
        <div className="meta-head__title">
          <h1>Méta par niveau</h1>
          <p className="lead">
            Dernières parties classées solo de votre serveur{platform ? ` (${platform})` : ''}, du Fer au Master+, sur le patch en cours.
            Le niveau de vos amis guide la génération des compositions et la draft.
          </p>
        </div>
        {options.length > 1 && (
          <div className="field meta-head__patch">
            <label className="field__label" htmlFor={`${id}-patch`}>Patch</label>
            <select
              id={`${id}-patch`}
              className="input"
              value={selectValue}
              onChange={(e) => setSelected(e.target.value)}
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.value} · {fmtInt(o.games)} parties{o.served ? ' (utilisé)' : ''}
                </option>
              ))}
            </select>
          </div>
        )}
      </header>

      {tiers.length > 0 && (
        <RankTierPanel
          tiers={tiers}
          hours={hours}
          view={viewTier}
          onView={setSelectedTier}
          choice={choice}
          override={override}
          onOverride={setOverride}
        />
      )}
      {!tiers.length && hours && <p className="hint">{formatWindow(hours)}.</p>}

      {loading ? (
        <div className="kpis" aria-busy="true"><Skeleton height={54} /></div>
      ) : meta && (
        <dl className="kpis">
          {shownTier && <div className="kpi"><dt>Niveau</dt><dd>{tierLabel(shownTier)}</dd></div>}
          <div className="kpi"><dt>Patch</dt><dd>{meta.patch || '—'}</dd></div>
          <div className="kpi"><dt>Parties</dt><dd>{fmtInt(meta.games)}</dd></div>
          <div className="kpi"><dt>Mise à jour</dt><dd>{formatDate(meta.updated_at)}</dd></div>
          {platform && <div className="kpi"><dt>Serveur</dt><dd>{platform}</dd></div>}
        </dl>
      )}
      {meta && meta.games < META_MIN_GAMES && (
        <p className="notice">
          Seulement {fmtInt(meta.games)} parties{shownTier ? ` en ${tierLabel(shownTier)}` : ''} sur ce patch : la génération et la draft
          attendent {META_MIN_GAMES} parties avant d’utiliser la méta d’un niveau. Les chiffres ci-dessous sont encore très bruités.
        </p>
      )}
      {meta && served && meta.patch !== served.patch && (
        <p className="notice">Patch {meta.patch} affiché pour comparaison : la génération utilise le patch {served.patch}.</p>
      )}
      {viewTier && choice?.tier && viewTier !== choice.tier && (
        <p className="notice">Niveau {tierLabel(viewTier)} affiché : les conseils utilisent {tierLabel(choice.tier)}.</p>
      )}

      <CollectPanel
        status={status.data}
        statusError={status.error}
        statusLoading={status.isLoading}
        progress={progress}
        defaultOpen={noMeta}
        onRetryStatus={() => void status.refetch()}
        keyLimits={keyLimits.data}
      />

      {stats.isError ? (
        <ErrorMessage error={stats.error} onRetry={() => void stats.refetch()} />
      ) : loading ? (
        <div className="stack" aria-busy="true" aria-label="Chargement de la méta…">
          <Skeleton height={40} />
          <Skeleton height={320} />
        </div>
      ) : !meta ? (
        <EmptyState icon="◆" title={viewTier ? `Pas encore de méta ${tierLabel(viewTier)}` : 'Pas encore de méta collectée'}>
          <p>
            Le serveur lit chaque heure{hours ? ` entre ${hours.start} h et ${hours.end} h` : ''} (tâche cron) les parties classées
            récentes de joueurs de chaque niveau, du Fer au Master+, et garde les dernières de chaque niveau pour le patch en cours.
            Tu peux aussi lancer la collecte à la main avec le mot de passe administrateur dans « Mettre à jour la méta » ci-dessus.
          </p>
          <p className="muted small">Comptez quelques passes avant d’avoir des chiffres : les limites de l’API Riot imposent un rythme lent.</p>
        </EmptyState>
      ) : (
        <TierTable meta={meta} champs={champs} onOpen={(cid, role) => setOpen({ id: cid, role })} />
      )}

      {meta && (
        <ChampionMetaDrawer
          meta={meta}
          championId={open?.id ?? null}
          initialRole={open?.role ?? null}
          champs={champs}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
