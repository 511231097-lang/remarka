import Link from "next/link";

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="site-footer">
      <div className="container footer-inner">
        <div className="footer-brand">
          <Link href="/" className="logo" style={{ fontSize: 20 }}>
            ремарка<span className="dot">.</span>
          </Link>
          <div className="footer-tag">
            AI-чат с книгами.
            <br />
            Разбираем тексты и отвечаем на сложные вопросы.
          </div>
        </div>

        <div className="footer-col">
          <div className="footer-title">Продукт</div>
          <Link href="/explore">Каталог</Link>
          <Link href="/library">Мои книги</Link>
          <Link href="/library">Чат</Link>
          <Link href="/upload">Загрузить книгу</Link>
          <Link href="/plans">Тарифы</Link>
        </div>

        <div className="footer-col">
          <div className="footer-title">Правовое</div>
          <Link href="/legal/terms">Пользовательское соглашение</Link>
          <Link href="/legal/privacy">Политика обработки ПДн</Link>
          <Link href="/legal/cookies">Cookie-файлы</Link>
          <Link href="/legal/upload">Условия загрузки произведений</Link>
          <Link href="/legal/copyright">Жалоба правообладателя</Link>
        </div>

        <div className="footer-col">
          <div className="footer-title">Контакты</div>
          <div className="footer-line">ИП Иванов И. И.</div>
          <div className="footer-line">ОГРНИП 000000000000000</div>
          <div className="footer-line">
            Адрес для корреспонденции:
            <br />
            г. Москва, а/я 000
          </div>
          <a href="mailto:hello@remarka.app">hello@remarka.app</a>
          <a href="mailto:abuse@remarka.app">abuse@remarka.app — жалобы</a>
        </div>
      </div>

      <div className="container footer-bottom">
        <div className="mono footer-mini">© {year} ремарка</div>
        <div className="mono footer-mini">
          Сервис анализирует тексты, но не предоставляет лицензии на произведения.
        </div>
      </div>
    </footer>
  );
}

export function ChatSidebarLegal() {
  return (
    <div className="chat-legal">
      <div className="chat-legal-links">
        <Link href="/legal/terms">Соглашение</Link>
        <span>·</span>
        <Link href="/legal/privacy">ПДн</Link>
        <span>·</span>
        <Link href="/legal/cookies">Cookie</Link>
        <span>·</span>
        <Link href="/legal/copyright">Жалоба</Link>
      </div>
      <div className="mono chat-legal-mini">© {new Date().getFullYear()} ремарка</div>
    </div>
  );
}
