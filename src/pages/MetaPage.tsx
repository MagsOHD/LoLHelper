import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useChampionMap, useMeta } from '../api/hooks';
import { refreshMetaEverywhere, useMetaCollection, useMetaStats, useMetaStatus } from '../api/metaHooks';
import { patchOptions, resolvePatch } from '../api/metaTier';
import type { Role } from '../api/types';
import { META_MIN_GAMES } from '../engine/meta';
import { formatDate } from '../lib/format';
import { CollectPanel } from '../components/meta/CollectPanel';
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

  const served = app.data?.meta_stats ?? null;
  const options = useMemo(() => patchOptions(status.data?.patches ?? [], served), [status.data?.patches, served]);
  const [selected, setSelected] = useState<string | null>(null);
  const patch = resolvePatch(selected, options);
  const stats = useMetaStats(patch);
  const meta = stats.data ?? null;

  const [open, setOpen] = useState<{ id: string; role: Role } | null>(null);

  // A pass finished elsewhere (hourly cron, another tab): refresh the snapshots once.
  const lastAt = status.data?.last_run?.at ?? null;
  const seenAt = useRef<string | null>(null);
  const looping = progress.phase === 'running' || progress.phase === 'waiting' || progress.phase === 'stopping';
  useEffect(() => {
    if (!lastAt) return;
    if (seenAt.current && seenAt.current !== lastAt && !looping) refreshMetaEverywhere(qc);
    seenAt.current = lastAt;
  }, [lastAt, looping, qc]);

  const platform = (meta?.platform || app.data?.platform || '').toUpperCase();
  const selectValue = selected ?? meta?.patch ?? served?.patch ?? options[0]?.value ?? '';
  const noMeta = !stats.isLoading && !stats.isError && !meta;

  return (
    <div className="page meta-page">
      <header className="meta-head">
        <div className="meta-head__title">
          <h1>Méta haut elo</h1>
          <p className="lead">
            Parties classées Challenger, Grandmaster et Master de votre serveur{platform ? ` (${platform})` : ''}, agrégées par patch.
            Les mêmes chiffres guident la génération des compositions et la draft.
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

      {stats.isLoading ? (
        <div className="kpis" aria-busy="true"><Skeleton height={54} /></div>
      ) : meta && (
        <dl className="kpis">
          <div className="kpi"><dt>Patch</dt><dd>{meta.patch || '—'}</dd></div>
          <div className="kpi"><dt>Parties</dt><dd>{fmtInt(meta.games)}</dd></div>
          <div className="kpi"><dt>Mise à jour</dt><dd>{formatDate(meta.updated_at)}</dd></div>
          {platform && <div className="kpi"><dt>Serveur</dt><dd>{platform}</dd></div>}
        </dl>
      )}
      {meta && meta.games < META_MIN_GAMES && (
        <p className="notice">
          Seulement {fmtInt(meta.games)} parties sur ce patch : la génération et la draft attendent {META_MIN_GAMES} parties avant
          d’utiliser la méta. Les chiffres ci-dessous sont encore très bruités.
        </p>
      )}
      {meta && served && meta.patch !== served.patch && (
        <p className="notice">Patch {meta.patch} affiché pour comparaison : la génération utilise le patch {served.patch}.</p>
      )}

      <CollectPanel
        status={status.data}
        statusError={status.error}
        statusLoading={status.isLoading}
        progress={progress}
        defaultOpen={noMeta}
        onRetryStatus={() => void status.refetch()}
      />

      {stats.isError ? (
        <ErrorMessage error={stats.error} onRetry={() => void stats.refetch()} />
      ) : stats.isLoading ? (
        <div className="stack" aria-busy="true" aria-label="Chargement de la méta…">
          <Skeleton height={40} />
          <Skeleton height={320} />
        </div>
      ) : !meta ? (
        <EmptyState icon="◆" title="Pas encore de méta collectée">
          <p>
            Le serveur lit chaque heure (tâche cron) les parties classées récentes des joueurs Challenger, Grandmaster et
            Master de votre serveur, puis les agrège par patch. Tu peux aussi lancer la collecte à la main avec le mot de
            passe administrateur dans « Mettre à jour la méta » ci-dessus.
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
