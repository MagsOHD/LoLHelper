import { NavLink, Route, Routes, Link } from 'react-router-dom';
import { useMemo } from 'react';
import { useMeta, usePlayers } from './api/hooks';
import { getPassword, MOCK_MODE } from './api/client';
import type { Meta } from './api/types';
import { tierLabel } from './api/metaRank';
import { TeamPage } from './pages/TeamPage';
import { PlayerPage } from './pages/PlayerPage';
import { CompositionsPage } from './pages/CompositionsPage';
import { MatchupPage } from './pages/MatchupPage';
import { SavedPage } from './pages/SavedPage';
import { DraftPage } from './pages/DraftPage';
import { MetaPage } from './pages/MetaPage';
import { useAdviceTier, useMetaCollectorBridge, useMetaStatus } from './api/metaHooks';
import { EmptyState } from './components/ui';
import { PasswordGate } from './components/PasswordGate';

const NAV: { to: string; label: string; short?: string; end?: boolean }[] = [
  { to: '/', label: 'Équipe', end: true },
  { to: '/compositions', label: 'Compositions', short: 'Compos' },
  { to: '/matchup', label: 'Matchup' },
  { to: '/saved', label: 'Sauvegardées', short: 'Sauvées' },
  { to: '/meta', label: 'Méta' },
];

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 3l11 6.5v13L16 29 5 22.5v-13z" fill="none" stroke="var(--gold)" strokeWidth="2.2" />
      <circle cx="16" cy="16" r="4.2" fill="var(--teal)" />
    </svg>
  );
}

/** "Méta : patch 16.22 · Or · 412 parties": tier used by the advice for all the friends. */
function FooterMeta({ app }: { app: Meta }) {
  const enabled = !app.password_required || Boolean(getPassword());
  const players = usePlayers(enabled);
  const ranks = useMemo(() => (players.data ?? []).map((p) => p.rank), [players.data]);
  const choice = useAdviceTier(ranks, enabled);
  const status = useMetaStatus(enabled);
  const summary = app.meta_stats ?? null;
  const tier = choice?.tier ?? null;
  const progress = (tier && status.data?.tiers.find((t) => t.tier === tier)) || null;
  if (!summary && !progress) return null;
  const nf = (n: number) => n.toLocaleString('fr-FR');
  const label = progress && tier
    ? `Méta : patch ${progress.patch || summary?.patch || '—'} · ${tierLabel(tier)} · ${nf(progress.games)} parties`
    : `Méta : patch ${summary?.patch} · ${nf(summary?.games ?? 0)} parties`;
  return <Link to="/meta" className="footer__link">{label}</Link>;
}

export function App() {
  const meta = useMeta();
  useMetaCollectorBridge();
  return (
    <div className="app">
      <a href="#main" className="skip-link">Aller au contenu</a>
      <header className="topbar">
        <div className="topbar__inner">
          <Link to="/" className="brand">
            <Logo />
            <span>Compo<span className="brand__accent"> entre amis</span></span>
          </Link>
          <nav className="nav" aria-label="Navigation principale">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav__link ${isActive ? 'is-active' : ''}`}>
                {n.short ? (
                  <>
                    <span className="nav__full">{n.label}</span>
                    <span className="nav__short">{n.short}</span>
                  </>
                ) : n.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      {meta.data && !meta.data.riot_configured && (
        <div className="banner" role="status">
          <span aria-hidden="true">ⓘ</span>
          <span>Clé API Riot non configurée — les joueurs sont créés en mode manuel (ajoute leur pool de champions à la main)</span>
        </div>
      )}
      {meta.isError && (
        <div className="banner banner--error" role="alert">
          Impossible de joindre le serveur : {meta.error.message}
        </div>
      )}

      <main id="main" className="main">
        <PasswordGate required={Boolean(meta.data?.password_required)}>
        <Routes>
          <Route path="/" element={<TeamPage />} />
          <Route path="/players/:id" element={<PlayerPage />} />
          <Route path="/compositions" element={<CompositionsPage />} />
          <Route path="/matchup" element={<MatchupPage />} />
          <Route path="/saved" element={<SavedPage />} />
          <Route path="/draft/:kind/:id" element={<DraftPage />} />
          <Route path="/meta" element={<MetaPage />} />
          <Route
            path="*"
            element={<EmptyState title="Page introuvable" action={<Link className="btn btn--primary" to="/">Retour à l’équipe</Link>} />}
          />
        </Routes>
        </PasswordGate>
      </main>
      <footer className="footer">
        {meta.data && <span>Patch {meta.data.ddragon_version} · {meta.data.platform.toUpperCase()}</span>}
        {meta.data && <FooterMeta app={meta.data} />}
        {MOCK_MODE && <span className="chip chip--amber">Mode démo (données fictives)</span>}
        <span>Projet non affilié à Riot Games.</span>
      </footer>
    </div>
  );
}
