import { NavLink, Route, Routes, Link } from 'react-router-dom';
import { useMeta } from './api/hooks';
import { MOCK_MODE } from './api/client';
import { TeamPage } from './pages/TeamPage';
import { PlayerPage } from './pages/PlayerPage';
import { CompositionsPage } from './pages/CompositionsPage';
import { MatchupPage } from './pages/MatchupPage';
import { SavedPage } from './pages/SavedPage';
import { EmptyState } from './components/ui';
import { PasswordGate } from './components/PasswordGate';

const NAV: { to: string; label: string; short?: string; end?: boolean }[] = [
  { to: '/', label: 'Équipe', end: true },
  { to: '/compositions', label: 'Compositions', short: 'Compos' },
  { to: '/matchup', label: 'Matchup' },
  { to: '/saved', label: 'Sauvegardées', short: 'Sauvées' },
];

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 3l11 6.5v13L16 29 5 22.5v-13z" fill="none" stroke="var(--gold)" strokeWidth="2.2" />
      <circle cx="16" cy="16" r="4.2" fill="var(--teal)" />
    </svg>
  );
}

export function App() {
  const meta = useMeta();
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
          <Route
            path="*"
            element={<EmptyState title="Page introuvable" action={<Link className="btn btn--primary" to="/">Retour à l’équipe</Link>} />}
          />
        </Routes>
        </PasswordGate>
      </main>
      <footer className="footer">
        {meta.data && <span>Patch {meta.data.ddragon_version} · {meta.data.platform.toUpperCase()}</span>}
        {MOCK_MODE && <span className="chip chip--amber">Mode démo (données fictives)</span>}
        <span>Projet non affilié à Riot Games.</span>
      </footer>
    </div>
  );
}
