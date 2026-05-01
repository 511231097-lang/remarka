// remarka — legal layer: Footer, Modals, Legal pages

const { useState: useL, useEffect: useLE } = React;

// ===== Footer (основной, на всех экранах кроме чата) =====
function SiteFooter({ go }) {
  const year = new Date().getFullYear();
  return (
    <footer className="site-footer">
      <div className="container footer-inner">
        <div className="footer-brand">
          <div className="logo" style={{ fontSize: 20 }}>ремарка<span className="dot">.</span></div>
          <div className="footer-tag">AI-чат с книгами.<br/>Разбираем тексты и отвечаем на сложные вопросы.</div>
        </div>

        <div className="footer-col">
          <div className="footer-title">Продукт</div>
          <a onClick={() => go("catalog")}>Каталог</a>
          <a onClick={() => go("library")}>Мои книги</a>
          <a onClick={() => go("chat")}>Чат</a>
          <a onClick={() => go("upload")}>Загрузить книгу</a>
          <a onClick={() => go("pricing")}>Тарифы</a>
        </div>

        <div className="footer-col">
          <div className="footer-title">Правовое</div>
          <a onClick={() => go("legal", "terms")}>Пользовательское соглашение</a>
          <a onClick={() => go("legal", "privacy")}>Политика обработки ПДн</a>
          <a onClick={() => go("legal", "cookies")}>Cookie-файлы</a>
          <a onClick={() => go("legal", "upload")}>Условия загрузки произведений</a>
          <a onClick={() => go("legal", "copyright")}>Жалоба правообладателя</a>
        </div>

        <div className="footer-col">
          <div className="footer-title">Контакты</div>
          <div className="footer-line">ИП Иванов И. И.</div>
          <div className="footer-line">ОГРНИП 000000000000000</div>
          <div className="footer-line">Адрес для корреспонденции:<br/>г. Москва, а/я 000</div>
          <a href="mailto:hello@remarka.app">hello@remarka.app</a>
          <a href="mailto:abuse@remarka.app">abuse@remarka.app — жалобы</a>
        </div>
      </div>

      <div className="container footer-bottom">
        <div className="mono footer-mini">© {year} ремарка</div>
        <div className="mono footer-mini">Сервис анализирует тексты, но не предоставляет лицензии на произведения.</div>
      </div>
    </footer>
  );
}

// ===== Chat sidebar legal row (компактная строка в сайдбаре чата) =====
function ChatSidebarLegal({ go }) {
  return (
    <div className="chat-legal">
      <div className="chat-legal-links">
        <a onClick={() => go("legal", "terms")}>Соглашение</a>
        <span>·</span>
        <a onClick={() => go("legal", "privacy")}>ПДн</a>
        <span>·</span>
        <a onClick={() => go("legal", "cookies")}>Cookie</a>
        <span>·</span>
        <a onClick={() => go("legal", "copyright")}>Жалоба</a>
      </div>
      <div className="mono chat-legal-mini">© {new Date().getFullYear()} ремарка</div>
    </div>
  );
}

// ===== Auth Modal v2 — с обязательной галкой =====
function AuthModalV2({ onClose, onSuccess, go }) {
  const [consent, setConsent] = useL(false);
  return (
    <Dialog onClose={onClose}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: -16 }}>
        <button className="btn-plain" style={{ padding: 6, borderRadius: 6 }} onClick={onClose}><Icon.Close/></button>
      </div>
      <div style={{ textAlign: "center", marginBottom: 24 }}>
        <div className="logo" style={{ fontSize: 28, justifyContent: "center", display: "inline-flex" }}>
          ремарка<span className="dot">.</span>
        </div>
        <h2 style={{ fontSize: 24, marginTop: 14, textWrap: "balance" }}>Войдите, чтобы начать разговор с книгой</h2>
        <p className="muted" style={{ fontSize: 14, marginTop: 10, textWrap: "balance" }}>
          Вход через Яндекс — без паролей. Библиотека и история чата сохранятся между устройствами.
        </p>
      </div>

      <button className={`btn btn-lg btn-block ${consent ? "btn-ghost" : ""}`}
        disabled={!consent}
        onClick={() => consent && onSuccess()}
        style={{ justifyContent: "center", gap: 12, opacity: consent ? 1 : 0.55, cursor: consent ? "pointer" : "not-allowed" }}>
        <span style={{ fontWeight: 800 }}>Я</span> Войти через Яндекс
      </button>

      <div style={{ marginTop: 18 }}>
        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer", fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.55 }}>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)}
            style={{ marginTop: 3, accentColor: "var(--ink)", flexShrink: 0 }}/>
          <span>
            Я принимаю{" "}
            <a className="lnk" onClick={(e) => { e.preventDefault(); go && go("legal", "terms"); }}>Пользовательское соглашение</a>{" "}
            и ознакомился с{" "}
            <a className="lnk" onClick={(e) => { e.preventDefault(); go && go("legal", "privacy"); }}>Политикой обработки персональных данных</a>.
            Обработка данных аккаунта, авторизации и истории чата — для исполнения договора об оказании услуг.
          </span>
        </label>
      </div>

      <div className="mono" style={{ fontSize: 10, color: "var(--ink-faint)", textAlign: "center", marginTop: 20, letterSpacing: "0.08em" }}>
        OAuth 2.0 · защищённое соединение
      </div>
    </Dialog>
  );
}

// ===== Cookie banner v2 — 3 кнопки =====
function CookieBannerV2({ onAcceptAll, onOnlyNecessary, onCustomize, go }) {
  return (
    <div className="cookie-banner">
      <div className="grow">
        <div style={{ fontSize: 14, color: "var(--ink)", marginBottom: 4, fontWeight: 500 }}>Про cookie-файлы</div>
        <div style={{ fontSize: 13, color: "var(--ink-muted)", lineHeight: 1.5 }}>
          Необходимые cookie-файлы включены всегда — без них не работает вход и сессия. Аналитику и персонализацию включаем только по вашему согласию.{" "}
          <a className="lnk" onClick={(e) => { e.preventDefault(); go && go("legal", "cookies"); }}>О cookie-файлах</a>{" · "}
          <a className="lnk" onClick={(e) => { e.preventDefault(); go && go("legal", "privacy"); }}>Политика ПДн</a>
        </div>
      </div>
      <div className="row-sm" style={{ flexShrink: 0, flexWrap: "wrap", gap: 8 }}>
        <button className="btn btn-plain btn-sm" onClick={onCustomize}>Настроить</button>
        <button className="btn btn-primary btn-sm" onClick={onAcceptAll}>Принять всё</button>
      </div>
    </div>
  );
}

// ===== Cookie settings modal =====
function CookieSettings({ onClose, onSave, initial }) {
  const [analytics, setAnalytics] = useL(initial?.analytics ?? true);
  const [perso, setPerso] = useL(initial?.perso ?? true);
  return (
    <Dialog onClose={onClose} maxWidth={520}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 }}>
        <div>
          <div className="mono eyebrow">Cookie-файлы</div>
          <h2 style={{ fontSize: 24, marginTop: 6 }}>Настройки cookie-файлов</h2>
        </div>
        <button className="btn-plain" style={{ padding: 6 }} onClick={onClose}><Icon.Close/></button>
      </div>
      <div className="stack">
        <CookieRow title="Необходимые" locked
          desc="Авторизация, сессия, защита от CSRF. Без них сайт не работает."/>
        <CookieRow title="Аналитика" checked={analytics} onChange={setAnalytics}
          desc="Помогают понять, какие разделы полезны, а какие — нет. Обезличенные."/>
        <CookieRow title="Персонализация" checked={perso} onChange={setPerso}
          desc="Рекомендации книг, недавние чаты, предпочтения отображения."/>
      </div>
      <div className="row" style={{ justifyContent: "flex-end", gap: 10, marginTop: 24 }}>
        <button className="btn btn-plain btn-sm" onClick={() => onSave({ analytics: false, perso: false })}>Отклонить всё</button>
        <button className="btn btn-primary btn-sm" onClick={() => onSave({ analytics, perso })}>Сохранить выбор</button>
      </div>
    </Dialog>
  );
}

function CookieRow({ title, desc, checked, onChange, locked }) {
  return (
    <div style={{ display: "flex", gap: 16, padding: "16px 18px", background: "var(--paper-2)", border: "1px solid var(--rule)", borderRadius: "var(--r)" }}>
      <div className="grow">
        <div style={{ fontWeight: 500, fontSize: 15 }}>{title}</div>
        <div style={{ fontSize: 13, color: "var(--ink-muted)", marginTop: 4, lineHeight: 1.5 }}>{desc}</div>
      </div>
      <div style={{ flexShrink: 0 }}>
        {locked ? (
          <div className="chip active" style={{ fontSize: 11 }}>Всегда</div>
        ) : (
          <label className="switch">
            <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)}/>
            <span className="switch-track"></span>
          </label>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { SiteFooter, ChatSidebarLegal, AuthModalV2, CookieBannerV2, CookieSettings });
