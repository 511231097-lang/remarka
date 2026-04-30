// remarka — Pricing screen + Paywall modal

const { useState: useSP, useEffect: useEP } = React;

// ===== Pricing page =====
function ScreenPricing({ go, plan, onUpgrade, onDowngrade }) {
  const isPlus = plan === "plus";

  const freeFeatures = [
    { t: "Полный каталог из 98 книг", on: true },
    { t: "Чат с любой книгой из каталога", on: true },
    { t: "Разбор-витрина на странице книги", on: true },
    { t: "Добавление книг из каталога в «Мои книги»", on: true },
    { t: "Цитаты и ссылки на страницы в каждом ответе", on: true },
    { t: "Загрузка своих книг (EPUB · FB2 · PDF)", on: false },
    { t: "Персональный анализ загруженных книг", on: false },
    { t: "Чат с собственными книгами", on: false },
  ];

  const plusFeatures = [
    { t: "Всё из бесплатного тарифа", on: true },
    { t: "Загрузка своих книг в любом формате", on: true },
    { t: "Глубокий анализ загруженных книг", on: true },
    { t: "Чат с каждой загруженной книгой", on: true },
    { t: "До 200 книг в личной полке", on: true },
    { t: "Экспорт разбора и цитат в Markdown", on: true },
    { t: "Приоритетная обработка — ~1 мин на книгу", on: true },
    { t: "Поддержка по email в течение 24 часов", on: true },
  ];

  return (
    <div className="screen-fade">
      {/* Шапка */}
      <div className="container-narrow" style={{ paddingTop: 72, paddingBottom: 24, textAlign: "center" }}>
        <div className="mono" style={{ color: "var(--mark)", marginBottom: 16 }}>Тарифы · выберите полку</div>
        <h1 style={{ fontSize: 56, letterSpacing: "-0.025em", lineHeight: 1.02, textWrap: "balance" }}>
          Читайте бесплатно.<br/>
          <span style={{ fontStyle: "italic", color: "var(--mark)" }}>Пишите</span> на Плюсе.
        </h1>
        <p className="soft" style={{ fontSize: 17, lineHeight: 1.6, marginTop: 22, maxWidth: 560, marginLeft: "auto", marginRight: "auto", textWrap: "pretty" }}>
          Каталог и разговор с книгами — бесплатно и без ограничений. Плюс открывает возможность
          загружать и анализировать собственные книги.
        </p>
      </div>

      {/* Тарифы */}
      <div className="container" style={{ paddingTop: 48, paddingBottom: 96 }}>
        <div className="pricing-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28, maxWidth: 960, margin: "0 auto" }}>

          {/* FREE */}
          <div className="card" style={{ padding: 36, position: "relative", background: "var(--cream)" }}>
            <div className="mono" style={{ color: "var(--ink-muted)", marginBottom: 12 }}>Тариф · 01</div>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
              <h2 style={{ fontSize: 36, letterSpacing: "-0.02em" }}>Читатель</h2>
              {plan === "free" && <div className="badge mark">Ваш план</div>}
            </div>
            <div style={{ marginTop: 20, display: "flex", alignItems: "baseline", gap: 8 }}>
              <div style={{ fontFamily: "var(--f-serif)", fontSize: 56, letterSpacing: "-0.02em", fontWeight: 500 }}>0<span style={{ color: "var(--mark)" }}>.</span></div>
              <div className="mono" style={{ color: "var(--ink-muted)" }}>₽ / бессрочно</div>
            </div>
            <p className="soft" style={{ fontSize: 14, lineHeight: 1.55, marginTop: 14 }}>
              Читайте, спрашивайте, собирайте цитаты. Всё, что есть в каталоге ремарки, — ваше.
            </p>

            <div className="hr" style={{ margin: "28px 0 24px" }}/>

            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 12 }}>
              {freeFeatures.map((f, i) => <FeatureLine key={i} on={f.on} t={f.t}/>)}
            </ul>

            <div style={{ marginTop: 32 }}>
              {plan === "free" ? (
                <button className="btn btn-ghost btn-lg btn-block" disabled style={{ opacity: .6, justifyContent: "center" }}>
                  Текущий план
                </button>
              ) : (
                <button className="btn btn-ghost btn-lg btn-block" onClick={onDowngrade} style={{ justifyContent: "center" }}>
                  Перейти на Читателя
                </button>
              )}
            </div>
          </div>

          {/* PLUS */}
          <div className="card" style={{
            padding: 36, position: "relative",
            background: "var(--paper-2)",
            border: "1px solid var(--mark)",
            boxShadow: "0 0 0 1px var(--mark-soft) inset, var(--shadow-lg)"
          }}>
            <div className="mono" style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              color: "var(--mark)", marginBottom: 12
            }}>
              <span>Тариф · 02</span>
              <span style={{
                padding: "3px 10px", background: "var(--mark)", color: "#fff",
                borderRadius: 100, fontSize: 9.5, letterSpacing: ".08em"
              }}>Для пишущих</span>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
              <h2 style={{ fontSize: 36, letterSpacing: "-0.02em" }}>
                Плюс
              </h2>
              {isPlus && <div className="badge mark">Ваш план</div>}
            </div>
            <div style={{ marginTop: 20, display: "flex", alignItems: "baseline", gap: 8 }}>
              <div style={{ fontFamily: "var(--f-serif)", fontSize: 56, letterSpacing: "-0.02em", fontWeight: 500 }}>
                390<span style={{ color: "var(--mark)" }}>.</span>
              </div>
              <div className="mono" style={{ color: "var(--ink-muted)" }}>₽ / месяц</div>
            </div>
            <p className="soft" style={{ fontSize: 14, lineHeight: 1.55, marginTop: 14 }}>
              Вся ремарка плюс загрузка собственных книг. Отмена в один клик — без сроков и штрафов.
            </p>

            <div className="hr" style={{ margin: "28px 0 24px" }}/>

            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 12 }}>
              {plusFeatures.map((f, i) => <FeatureLine key={i} on={f.on} t={f.t} mark/>)}
            </ul>

            <div style={{ marginTop: 32 }}>
              {isPlus ? (
                <button className="btn btn-ghost btn-lg btn-block" disabled style={{ opacity: .6, justifyContent: "center" }}>
                  Вы на Плюсе
                </button>
              ) : (
                <button className="btn btn-mark btn-lg btn-block" onClick={onUpgrade} style={{ justifyContent: "center" }}>
                  Перейти на Плюс <Icon.Arrow/>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* FAQ */}
        <div style={{ maxWidth: 720, margin: "96px auto 0" }}>
          <div className="mono" style={{ color: "var(--mark)", marginBottom: 12, textAlign: "center" }}>Частые вопросы</div>
          <h2 style={{ fontSize: 32, letterSpacing: "-0.02em", textAlign: "center", marginBottom: 40 }}>Коротко о тарифах</h2>

          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {[
              { q: "Можно ли пользоваться бесплатно всегда?",
                a: "Да. Бесплатный тариф — бессрочный. Каталог из 98 книг и чат с каждой из них из каталога доступны без ограничений по времени." },
              { q: "Что происходит с загруженными книгами, если отменить Плюс?",
                a: "Книги остаются в вашей библиотеке и доступны для чтения и экспорта цитат. Чат по ним ставится на паузу до следующей подписки. Никто кроме вас эти файлы не видит." },
              { q: "Используются ли мои книги для обучения моделей?",
                a: "Нет. Загруженные файлы обрабатываются только для построения вашего разбора и не передаются ни в тренировочные наборы, ни в общий каталог." },
              { q: "Как отменить подписку?",
                a: "В профиле в разделе «Подписка» — одной кнопкой. Подписка действует до конца оплаченного периода, автопродления не будет." },
              { q: "Есть ли годовой тариф?",
                a: "Пока нет. Мы хотим, чтобы вы платили только за месяцы, когда читаете активно." },
            ].map((f, i) => <FAQRow key={i} q={f.q} a={f.a}/>)}
          </div>
        </div>

        {/* Мелкая сноска */}
        <div className="mono" style={{ color: "var(--ink-faint)", textAlign: "center", marginTop: 64, fontSize: 11, letterSpacing: ".06em" }}>
          Оплата принимается через защищённый платёжный шлюз. НДС включён. Отмена в один клик.
        </div>
      </div>
    </div>
  );
}

function FeatureLine({ on, t, mark }) {
  return (
    <li style={{ display: "flex", alignItems: "flex-start", gap: 12, fontSize: 14, lineHeight: 1.5, color: on ? "var(--ink)" : "var(--ink-faint)" }}>
      <div style={{
        width: 18, height: 18, borderRadius: "50%", flexShrink: 0, marginTop: 2,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: on ? (mark ? "var(--mark)" : "var(--ink)") : "transparent",
        border: on ? "none" : "1px solid var(--rule)",
        color: "#fff"
      }}>
        {on ? <Icon.Check2/> : <span style={{ width: 8, height: 1, background: "var(--ink-faint)" }}/>}
      </div>
      <span style={{ textDecoration: on ? "none" : "line-through", textDecorationColor: "var(--ink-faint)" }}>{t}</span>
    </li>
  );
}

function FAQRow({ q, a }) {
  const [open, setOpen] = useSP(false);
  return (
    <div style={{ borderBottom: "1px solid var(--rule)", padding: "20px 0" }}>
      <button onClick={() => setOpen(!open)} style={{
        all: "unset", cursor: "pointer", width: "100%",
        display: "flex", justifyContent: "space-between", alignItems: "center", gap: 20
      }}>
        <div style={{ fontFamily: "var(--f-serif)", fontSize: 18, color: "var(--ink)" }}>{q}</div>
        <div style={{
          width: 28, height: 28, borderRadius: "50%", border: "1px solid var(--rule)",
          display: "flex", alignItems: "center", justifyContent: "center",
          transform: open ? "rotate(45deg)" : "none", transition: "transform .2s", flexShrink: 0
        }}>
          <Icon.Plus/>
        </div>
      </button>
      {open && (
        <p className="soft" style={{ fontSize: 15, lineHeight: 1.6, marginTop: 14, maxWidth: 600 }}>
          {a}
        </p>
      )}
    </div>
  );
}

// ===== Paywall Modal — for Free users hitting upload =====
function PaywallModal({ onClose, onUpgrade, onSeePlans, feature = "upload" }) {
  const copy = {
    upload: {
      eyebrow: "Только на Плюсе",
      title: "Загрузка своих книг — возможность Плюса",
      body: "Бесплатный тариф позволяет читать и обсуждать любые книги из каталога. Чтобы загрузить собственный EPUB, FB2 или PDF и получить по нему личный разбор — перейдите на Плюс.",
    },
    analyze: {
      eyebrow: "Только на Плюсе",
      title: "Персональный анализ — возможность Плюса",
      body: "Глубокий разбор загруженных книг доступен на тарифе Плюс. На бесплатном — чат и каталог, и этого часто хватает.",
    },
  }[feature] || { eyebrow: "Плюс", title: "Нужен тариф Плюс", body: "Эта возможность доступна на тарифе Плюс." };

  return (
    <Dialog onClose={onClose} maxWidth={520}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: -16 }}>
        <button className="btn-plain" style={{ padding: 6, borderRadius: 6 }} onClick={onClose}><Icon.Close/></button>
      </div>

      <div style={{ textAlign: "center", padding: "8px 0 4px" }}>
        <div className="mono" style={{ color: "var(--mark)", marginBottom: 14 }}>{copy.eyebrow}</div>
        <h2 style={{ fontSize: 28, letterSpacing: "-0.02em", lineHeight: 1.15, textWrap: "balance" }}>
          {copy.title}
        </h2>
        <p className="soft" style={{ fontSize: 15, lineHeight: 1.6, marginTop: 14, textWrap: "pretty" }}>
          {copy.body}
        </p>
      </div>

      <div style={{
        marginTop: 28, padding: "20px 22px", background: "var(--paper-2)",
        border: "1px solid var(--mark)", borderRadius: "var(--r-lg)"
      }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
          <div>
            <div style={{ fontFamily: "var(--f-serif)", fontSize: 22, letterSpacing: "-0.01em" }}>Плюс</div>
            <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 2 }}>Отмена в один клик</div>
          </div>
          <div style={{ fontFamily: "var(--f-serif)", fontSize: 28, fontWeight: 500 }}>
            390<span style={{ color: "var(--mark)", fontSize: 20 }}>.</span>
            <span className="mono" style={{ fontSize: 12, color: "var(--ink-muted)", marginLeft: 4 }}>₽/мес</span>
          </div>
        </div>
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {[
            "Загрузка своих книг в EPUB · FB2 · PDF",
            "Персональный AI-разбор каждой книги",
            "Отдельный чат с каждой вашей книгой",
          ].map((t, i) => (
            <li key={i} style={{ display: "flex", gap: 10, fontSize: 13.5, color: "var(--ink)", alignItems: "center" }}>
              <div style={{ width: 16, height: 16, borderRadius: "50%", background: "var(--mark)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Icon.Check2/>
              </div>
              {t}
            </li>
          ))}
        </ul>
      </div>

      <div className="row" style={{ marginTop: 24, justifyContent: "center", gap: 12 }}>
        <button className="btn btn-plain" onClick={onSeePlans}>Сравнить тарифы</button>
        <button className="btn btn-mark btn-lg" onClick={onUpgrade} style={{ flex: 1, justifyContent: "center" }}>
          Перейти на Плюс <Icon.Arrow/>
        </button>
      </div>

      <div className="mono" style={{ fontSize: 10, color: "var(--ink-faint)", textAlign: "center", marginTop: 20, letterSpacing: "0.08em" }}>
        Без автопродления · отмена в любой момент
      </div>
    </Dialog>
  );
}

Object.assign(window, { ScreenPricing, PaywallModal });
