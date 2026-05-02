// Home page — Apps Father main screen with list of apps
const { useState: hUseState } = React;

function HomeHeader({ accent }) {
  return (
    <div className="home-top">
      <button className="home-icon-btn">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
        </svg>
      </button>
      <button className="home-icon-btn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
      </button>
    </div>
  );
}

function HomeHero({ accent }) {
  return (
    <div className="home-hero">
      <div className="home-logo" style={{ background: accent }}>
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="14" height="14" rx="3" fill="#fff" stroke="none" />
        </svg>
        <div className="home-logo-dot" />
      </div>
      <h1 className="home-title">Apps Father</h1>
      <p className="home-sub">Create and manage your AI-built apps. Build, update, and publish — all from here.</p>
    </div>
  );
}

function BalanceCard({ accent }) {
  return (
    <div className="balance-cards">
      <button className="balance-card balance-card-coins">
        <div className="bc-icon" style={{ background: "linear-gradient(135deg, #F59E0B, #B45309)" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff">
            <circle cx="12" cy="12" r="9" opacity="0.95" />
            <circle cx="12" cy="12" r="5.5" fill="#FBBF24" />
          </svg>
        </div>
        <div className="bc-text">
          <div className="bc-label">Balance: <span className="bc-amt">6 039</span></div>
          <div className="bc-sub">Tap to top up</div>
        </div>
        <Icon name="chevron" size={14} color="rgba(255,255,255,0.4)" />
      </button>
      <button className="balance-card balance-card-credits">
        <div className="bc-icon" style={{ background: "rgba(124, 58, 237, 0.2)", border: "1px solid rgba(124, 58, 237, 0.5)" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#A78BFA" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 15 9 22 9.5 17 14.5 18.5 22 12 18 5.5 22 7 14.5 2 9.5 9 9 12 2" />
          </svg>
        </div>
        <div className="bc-text">
          <div className="bc-label">Earn Credits</div>
          <div className="bc-sub">Complete tasks &amp; get rewards</div>
        </div>
        <Icon name="chevron" size={14} color="rgba(255,255,255,0.4)" />
      </button>
    </div>
  );
}

function SearchBar() {
  return (
    <div className="search-bar">
      <Icon name="search" size={15} color="rgba(255,255,255,0.4)" />
      <input className="search-input" placeholder="Search" />
    </div>
  );
}

function AppRow({ app, accent, onOpen }) {
  const meta = window.STATUS_META[app.status];
  return (
    <button className="app-row" onClick={onOpen}>
      <div className="app-avatar" style={{ background: app.color }}>
        <span>{app.initials}</span>
      </div>
      <div className="app-meta">
        <div className="app-name">{app.name}</div>
        {app.handle && <div className="app-handle mono">{app.handle}</div>}
      </div>
      <div className="app-status">
        <span className="status-pill">
          <span className="status-pill-dot" style={{ background: meta.color, boxShadow: `0 0 6px ${meta.color}` }} />
          <span>{meta.label}</span>
        </span>
      </div>
      <Icon name="chevron" size={13} color="rgba(255,255,255,0.4)" />
    </button>
  );
}

function HomeScreen({ accent, onOpenApp }) {
  return (
    <div className="home-scroll">
      <HomeHeader accent={accent} />
      <HomeHero accent={accent} />
      <BalanceCard accent={accent} />
      <SearchBar />

      <div className="apps-section-head">
        <h2 className="apps-title">My Apps <span className="apps-count">(14/16)</span></h2>
      </div>

      <div className="apps-list">
        <button className="app-row create-row" onClick={() => onOpenApp(window.APPS_DATA[0])}>
          <div className="create-icon" style={{ borderColor: accent, color: accent }}>
            <Icon name="plus" size={18} color={accent} />
          </div>
          <div className="create-label" style={{ color: accent }}>Create New App</div>
        </button>

        {window.APPS_DATA.map((app) => (
          <AppRow key={app.id} app={app} accent={accent} onOpen={() => onOpenApp(app)} />
        ))}
      </div>

      <div className="home-foot" />
    </div>
  );
}

window.HomeScreen = HomeScreen;
