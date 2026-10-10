import { NavLink, Outlet } from 'react-router';

export const REPO_URL = 'https://github.com/Tariqali13/onsale';

export function Layout() {
  return (
    <div className="shell">
      <header className="topbar">
        <NavLink to="/" className="wordmark" aria-label="Onsale home">
          <svg viewBox="0 0 34 22" aria-hidden="true">
            <path d="M0 0h34v7a4 4 0 0 0 0 8v7H0v-7a4 4 0 0 0 0-8z" fill="#FFC93C" />
            <path d="M23 2v18" stroke="#1D1846" strokeWidth="1.6" strokeDasharray="2 2" />
          </svg>
          Onsale
        </NavLink>
        <nav className="nav" aria-label="Main">
          <NavLink to="/" end>
            Buy tickets
          </NavLink>
          <NavLink to="/ops">Live ops</NavLink>
          <a href={REPO_URL}>Source code</a>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
      <footer className="footer">
        <span>A demo of a high-traffic ticket onsale. The band, venue and payments are not real.</span>
        <span>
          Built by <a href="https://tariqali.dev">Tariq Ali</a>
        </span>
      </footer>
    </div>
  );
}
