// remarka — общие компоненты

const { useState, useEffect, useRef, useMemo } = React;

// ===== Icons (inline, minimal) =====
const Icon = {
  Search: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" {...p}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>,
  Chat: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-5.5A8 8 0 1 1 21 12z"/></svg>,
  Plus: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" {...p}><path d="M12 5v14M5 12h14"/></svg>,
  Check: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M20 6 9 17l-5-5"/></svg>,
  Arrow: (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M5 12h14M13 6l6 6-6 6"/></svg>,
  Upload: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 15V3M7 8l5-5 5 5M5 21h14"/></svg>,
  Book: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2V5zM4 18h15"/></svg>,
  Library: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M4 3v18M8 3v18M14 5l4 14M19 21l-4-14"/></svg>,
  Sparkle: (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>,
  Send: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>,
  Close: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" {...p}><path d="M6 6l12 12M18 6 6 18"/></svg>,
  User: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>,
  Quote: (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M7 7c-2 .8-3 2.5-3 5v5h5v-5H6c0-1.5.8-2.7 2-3.2L7 7zm9 0c-2 .8-3 2.5-3 5v5h5v-5h-3c0-1.5.8-2.7 2-3.2L16 7z"/></svg>,
  Bookmark: (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M6 3h12v18l-6-4-6 4V3z"/></svg>,
  Settings: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>,
  Filter: (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 5h18M6 12h12M10 19h4"/></svg>,
  Google: (p) => <svg width="18" height="18" viewBox="0 0 24 24" {...p}><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.57c2.08-1.92 3.27-4.74 3.27-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.76c-.99.66-2.25 1.06-3.71 1.06-2.86 0-5.29-1.93-6.15-4.53H2.17v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.85 14.1a6.6 6.6 0 0 1 0-4.2V7.07H2.17a11 11 0 0 0 0 9.87l3.68-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.1 14.97 1 12 1 7.7 1 3.99 3.47 2.17 7.07l3.68 2.84C6.71 7.3 9.14 5.38 12 5.38z"/></svg>,
  Check2: (p) => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M20 6 9 17l-5-5"/></svg>,
};

// ===== BookCover =====
function BookCover({ book, size = "md" }) {
  const cls = size === "lg" ? "cover cover-lg" : size === "sm" ? "cover cover-sm" : "cover";
  const style = { "--cover-bg": book.cover?.bg || "oklch(40% 0.1 30)", "--cover-fg": book.cover?.fg || "#fff" };
  return (
    <div className={cls} style={style}>
      <div className="c-top">{book.tag || "Книга"}</div>
      <div className="c-title">{book.title}</div>
      <div className="c-author">{book.author}</div>
    </div>
  );
}

// ===== BookCard =====
function BookCard({ book, onClick, owned }) {
  return (
    <div className="book-card" onClick={onClick}>
      <BookCover book={book} />
      <div className="meta">
        <div className="t">{book.title}</div>
        <div className="a">{book.author}{book.year ? `, ${book.year}` : ""}</div>
        {owned && <div style={{ marginTop: 6 }}><span className="badge"><Icon.Check2/> В библиотеке</span></div>}
      </div>
    </div>
  );
}

// ===== Navbar =====
function Navbar({ route, go, authed, plan = "free", onSignIn, onProfile }) {
  const items = [
    { k: "catalog", t: "Каталог" },
    { k: "library", t: "Мои книги" },
    { k: "pricing", t: "Тарифы" },
    { k: "legal:copyright", t: "Правообладателям" },
  ];
  const isPlus = plan === "plus";
  const [drawerOpen, setDrawerOpen] = useState(false);
  const goAndClose = (k, arg) => { setDrawerOpen(false); if (arg !== undefined) go(k, arg); else go(k); };

  return (
    <div className="navbar">
      <div className="container navbar-inner">
        <div className="logo" onClick={() => go("landing")} style={{ cursor: "pointer" }}>
          ремарка<span className="dot">.</span>
        </div>
        <div className="nav-links">
          {items.map((it) => {
            const isLegal = it.k.startsWith("legal:");
            const legalKey = isLegal ? it.k.slice(6) : null;
            const active = isLegal ? (route === "legal-copyright" || route === `legal:${legalKey}`) : route === it.k;
            return (
              <div key={it.k}
                className={`nav-link ${active ? "active" : ""}`}
                onClick={() => isLegal ? go("legal", legalKey) : go(it.k)}>{it.t}</div>
            );
          })}
          <div style={{ width: 16 }}/>
          {authed ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {isPlus ? (
                <div className="plan-pill plus" title="Тариф Плюс" onClick={onProfile}>
                  <Icon.Sparkle/> Плюс
                </div>
              ) : (
                <button className="btn btn-ghost btn-sm" onClick={() => go("pricing")} style={{ padding: "6px 12px" }}>
                  Плюс
                </button>
              )}
              <button className="avatar" onClick={onProfile} title="Профиль">А</button>
            </div>
          ) : (
            <button className="btn btn-ghost btn-sm" onClick={onSignIn}>Войти</button>
          )}
        </div>

        <button className="nav-burger" onClick={() => setDrawerOpen(true)} aria-label="Меню">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="18" y2="18"/></svg>
        </button>
      </div>

      {ReactDOM.createPortal(
      <div className={`mobile-drawer ${drawerOpen ? "open" : ""}`} onClick={(e) => { if (e.target === e.currentTarget) setDrawerOpen(false); }}>
        <div className="mobile-drawer-panel">
          <button className="mobile-drawer-close" onClick={() => setDrawerOpen(false)} aria-label="Закрыть">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
          {authed && (
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 4px 18px", borderBottom: "1px solid var(--rule)", marginBottom: 10 }}>
              <button className="avatar" onClick={() => goAndClose("profile")} style={{ margin: 0 }}>А</button>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 500 }}>Мой аккаунт</div>
                <div style={{ fontSize: 12, color: "var(--ink-muted)", marginTop: 2 }}>Тариф · {isPlus ? "Плюс" : "Читатель"}</div>
              </div>
            </div>
          )}
          {items.map((it) => {
            const isLegal = it.k.startsWith("legal:");
            const legalKey = isLegal ? it.k.slice(6) : null;
            const active = isLegal ? (route === "legal-copyright" || route === `legal:${legalKey}`) : route === it.k;
            return (
              <button key={it.k}
                className={`m-link ${active ? "active" : ""}`}
                onClick={() => isLegal ? goAndClose("legal", legalKey) : goAndClose(it.k)}>
                {it.t}
              </button>
            );
          })}
          <button className={`m-link ${route === "chat" ? "active" : ""}`} onClick={() => goAndClose("chat")}>Чат</button>
          {!isPlus && (
            <button className="m-link" style={{ color: "var(--mark)", fontWeight: 500 }} onClick={() => goAndClose("pricing")}>
              <Icon.Sparkle/> Перейти на Плюс
            </button>
          )}
          <div style={{ flex: 1 }}/>
          {!authed && (
            <button className="btn btn-primary" onClick={() => { setDrawerOpen(false); onSignIn(); }} style={{ marginTop: 14 }}>Войти</button>
          )}
        </div>
      </div>,
      document.body)}
    </div>
  );
}

// ===== Dialog shell =====
function Dialog({ onClose, children, maxWidth = 440 }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" style={{ maxWidth }} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

// ===== Auth Modal =====
function AuthModal({ onClose, onSuccess }) {
  const [consent, setConsent] = useState(true);
  return (
    <Dialog onClose={onClose}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: -16 }}>
        <button className="btn-plain" style={{ padding: 6, borderRadius: 6 }} onClick={onClose}><Icon.Close/></button>
      </div>
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <div className="logo" style={{ fontSize: 28, justifyContent: "center", display: "inline-flex" }}>
          ремарка<span className="dot">.</span>
        </div>
        <h2 style={{ fontSize: 24, marginTop: 14, textWrap: "balance" }}>Войдите, чтобы начать разговор с книгой</h2>
        <p className="muted" style={{ fontSize: 14, marginTop: 10, textWrap: "balance" }}>Вход через Google — без паролей. Ваша библиотека и история чата сохранятся между устройствами.</p>
      </div>
      <button className="btn btn-ghost btn-lg btn-block" onClick={() => consent && onSuccess()} style={{ justifyContent: "center", gap: 12 }}>
        <Icon.Google/> Войти через Google
      </button>
      <div style={{ marginTop: 20 }}>
        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer", fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.5 }}>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)}
            style={{ marginTop: 2, accentColor: "var(--ink)" }}/>
          <span>Я принимаю <a style={{ textDecoration: "underline" }}>условия</a> и <a style={{ textDecoration: "underline" }}>политику конфиденциальности</a>. Вход и сессии используют защищённый протокол OAuth 2.0.</span>
        </label>
      </div>
      <div className="mono" style={{ fontSize: 10, color: "var(--ink-faint)", textAlign: "center", marginTop: 22, letterSpacing: "0.08em" }}>
        OAuth 2.0 · защищённое соединение
      </div>
    </Dialog>
  );
}

// ===== Cookie banner =====
function CookieBanner({ onAccept, onCustomize }) {
  return (
    <div className="cookie-banner">
      <div className="grow">
        <div style={{ fontSize: 14, color: "var(--ink)", marginBottom: 4, fontWeight: 500 }}>Про cookie-файлы</div>
        <div style={{ fontSize: 13, color: "var(--ink-muted)", lineHeight: 1.5 }}>
          Мы используем cookie-файлы для работы авторизации, сохранения настроек и улучшения рекомендаций.
          Необходимые cookie-файлы включены всегда.
        </div>
      </div>
      <div className="row-sm">
        <button className="btn btn-plain btn-sm" onClick={onCustomize}>Настроить</button>
        <button className="btn btn-primary btn-sm" onClick={onAccept}>Принять</button>
      </div>
    </div>
  );
}

// ===== Chip group =====
function ChipGroup({ items, active, onPick }) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {items.map((it) => (
        <div key={it} className={`chip ${active === it ? "active" : ""}`} onClick={() => onPick(it)}>{it}</div>
      ))}
    </div>
  );
}

// ===== Section header =====
function SectionHead({ eyebrow, title, right }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24, marginBottom: 20 }}>
      <div>
        {eyebrow && <div className="mono" style={{ color: "var(--mark)", marginBottom: 8 }}>{eyebrow}</div>}
        <h2 style={{ fontSize: 28, letterSpacing: "-0.015em" }}>{title}</h2>
      </div>
      {right}
    </div>
  );
}

Object.assign(window, { Icon, BookCover, BookCard, Navbar, Dialog, AuthModal, CookieBanner, ChipGroup, SectionHead });
