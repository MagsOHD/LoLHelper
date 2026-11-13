import { useEffect, useId, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import type { MetaStatus } from '../../api/meta';
import { stopLabel, type CollectProgress } from '../../api/metaCollect';
import { loadAdminPassword, metaCollector, saveAdminPassword } from '../../api/metaHooks';
import { formatDate } from '../../lib/format';
import { ErrorMessage, Skeleton, Spinner } from '../ui';
import { fmtInt } from './format';

const ACTIVE = new Set<CollectProgress['phase']>(['running', 'waiting', 'stopping']);

/** Ticks every second while `on` (countdown of the busy retry). */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

function LastRun({ run }: { run: NonNullable<MetaStatus['last_run']> }) {
  const who = run.source === 'web' ? 'manuelle' : run.source === 'cron' ? 'automatique' : '';
  return (
    <p className="hint">
      Dernière passe{who ? ` ${who}` : ''} : {formatDate(run.at)} · {fmtInt(run.new_matches)} nouvelles parties ·{' '}
      {fmtInt(run.requests)} requêtes · arrêt : {stopLabel(run.stop, run.retry_after)}
    </p>
  );
}

function Progress({ p }: { p: CollectProgress }) {
  const active = ACTIVE.has(p.phase);
  const now = useNow(p.phase === 'waiting');
  const wait = p.retry_at ? Math.max(0, Math.ceil((p.retry_at - now) / 1000)) : null;
  if (p.phase === 'idle') return null;
  return (
    <div className={`collect__progress collect__progress--${p.phase}`}>
      <p className="collect__line">
        {active && <Spinner label="Collecte en cours" />}
        {p.phase === 'done' && <span aria-hidden="true" className="ok">✓</span>}
        <span>
          {p.phase === 'waiting' && wait !== null
            ? `Une collecte tourne déjà sur le serveur (cron horaire ou autre onglet). Nouvel essai dans ${wait} s…`
            : p.message}
        </span>
      </p>
      {(active || p.passes > 0) && <dl className="collect__stats">
        <div><dt>Passes</dt><dd>{fmtInt(p.passes)}</dd></div>
        <div><dt>Requêtes Riot</dt><dd>{fmtInt(p.requests)}</dd></div>
        <div><dt>Nouvelles parties</dt><dd>{fmtInt(p.new_matches)}</dd></div>
        <div><dt>{p.patch ? `Parties ${p.patch}` : 'Parties du patch'}</dt><dd>{p.games === null ? '—' : fmtInt(p.games)}</dd></div>
      </dl>}
      {p.last_stop && (
        <p className="hint">Dernier arrêt de passe : {stopLabel(p.last_stop)}{p.full_rounds === 1 ? ' (encore un tour pour confirmer)' : ''}</p>
      )}
      {p.error && <ErrorMessage error={new Error(p.error)} />}
    </div>
  );
}

/** "Mettre à jour la méta": admin password + loop of server passes with live progress. */
export function CollectPanel({ status, statusError, statusLoading, progress, defaultOpen, onRetryStatus }: {
  status: MetaStatus | undefined;
  statusError: unknown;
  statusLoading: boolean;
  progress: CollectProgress;
  defaultOpen: boolean;
  onRetryStatus: () => void;
}) {
  const id = useId();
  const [password, setPassword] = useState(loadAdminPassword);
  const active = ACTIVE.has(progress.phase);
  const [open, setOpen] = useState(defaultOpen || active);
  useEffect(() => {
    if (defaultOpen || active) setOpen(true);
  }, [defaultOpen, active]);

  // Wrong admin password: forget it so the next attempt starts from an empty field.
  useEffect(() => {
    if (progress.phase === 'error' && progress.error_status === 401) {
      saveAdminPassword('');
      setPassword('');
    }
  }, [progress.phase, progress.error_status]);

  const start = (e: FormEvent) => {
    e.preventDefault();
    const pw = password.trim();
    if (!pw || active) return;
    saveAdminPassword(pw);
    metaCollector.start(pw);
  };

  const summary = active
    ? progress.phase === 'waiting' ? 'en attente du serveur…' : progress.phase === 'stopping' ? 'arrêt en cours…' : `passe ${progress.passes + 1} en cours…`
    : status?.collecting ? 'collecte automatique en cours sur le serveur'
      : status?.last_run ? `dernière passe : ${formatDate(status.last_run.at)}` : '';

  const missingRoute = statusError instanceof ApiError && statusError.status === 404;

  let body;
  if (statusLoading) {
    body = <Skeleton height={64} />;
  } else if (missingRoute) {
    body = (
      <p className="notice">
        Le serveur ne propose pas encore la collecte manuelle : mettez à jour le dossier <code>api/</code> de l’hébergement.
        La collecte automatique (cron) continue de fonctionner.
      </p>
    );
  } else if (statusError || !status) {
    body = <ErrorMessage error={statusError ?? new Error('État de la collecte indisponible.')} onRetry={onRetryStatus} />;
  } else if (!status.meta_enabled) {
    body = (
      <p className="notice">
        La collecte méta est désactivée dans <code>config.php</code> (<code>meta_enabled</code>) : ni le cron ni ce bouton ne collectent.
      </p>
    );
  } else if (!status.admin_enabled) {
    body = (
      <>
        <p className="notice">
          Collecte manuelle désactivée : définissez <code>admin_password</code> dans <code>config.php</code> sur l’hébergement
          (différent du mot de passe partagé du site). La collecte automatique toutes les heures n’est pas concernée.
        </p>
        {status.last_run && <LastRun run={status.last_run} />}
      </>
    );
  } else {
    body = (
      <>
        <p className="hint">
          Chaque passe dure au plus ~45 s sur le serveur. Les passes s’enchaînent jusqu’à « Arrêter », deux tours complets
          de suite ou une erreur. Tu peux changer de page : la collecte continue dans cet onglet.
        </p>
        {status.collecting && !active && (
          <p className="notice" role="status">Une collecte automatique tourne en ce moment sur le serveur : « Lancer » attendra qu’elle se termine.</p>
        )}
        <form className="collect__form" onSubmit={start}>
          <div className="field field--grow">
            <label className="field__label" htmlFor={id}>Mot de passe administrateur</label>
            <input
              id={id}
              className="input"
              type="password"
              autoComplete="off"
              value={password}
              disabled={active}
              onChange={(e) => setPassword(e.target.value)}
              aria-describedby={`${id}-hint`}
            />
          </div>
          {active ? (
            <button type="button" className="btn btn--danger collect__btn" onClick={() => metaCollector.stop()} disabled={progress.phase === 'stopping'}>
              {progress.phase === 'stopping' ? 'Arrêt…' : 'Arrêter'}
            </button>
          ) : (
            <button type="submit" className="btn btn--primary collect__btn" disabled={!password.trim()}>Lancer</button>
          )}
        </form>
        <p className="hint" id={`${id}-hint`}>Gardé seulement pour cet onglet (jamais enregistré sur l’appareil).</p>
        <div aria-live="polite">
          <Progress p={progress} />
        </div>
        {!active && progress.phase === 'idle' && status.last_run && <LastRun run={status.last_run} />}
      </>
    );
  }

  return (
    <details className="card collect" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="collect__summary">
        <span className="collect__title">Mettre à jour la méta</span>
        {summary && <span className="collect__state">{active && <span className="spinner" aria-hidden="true" />}{summary}</span>}
      </summary>
      <div className="collect__body">{body}</div>
    </details>
  );
}
