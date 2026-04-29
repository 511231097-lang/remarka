// remarka — экраны: BookPage, ChatBook

const { useState: useS2, useEffect: useE2, useRef: useR2 } = React;

function ScreenBook({ bookId, go, addBook, owned, onChat }) {
  const book = window.REMARKA.BOOKS.find((b) => b.id === bookId) || window.REMARKA.BOOKS[0];
  const inLib = owned.has(book.id);

  return (
    <div className="screen-fade">
      {/* Шапка страницы */}
      <div style={{ background: "var(--paper-2)", borderBottom: "1px solid var(--rule)" }}>
        <div className="container" style={{ paddingTop: 48, paddingBottom: 48 }}>
          <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 48, alignItems: "flex-start" }}>
            <div style={{ width: 260 }}>
              <BookCover book={book} size="lg"/>
            </div>
            <div>
              <div className="mono" style={{ color: "var(--mark)", marginBottom: 16 }}>
                {book.tag} · {book.year} · {book.pages} стр.
              </div>
              <h1 style={{ fontSize: 52, letterSpacing: "-0.02em", lineHeight: 1.02, textWrap: "balance" }}>{book.title}</h1>
              <div style={{ fontFamily: "var(--f-serif)", fontStyle: "italic", fontSize: 20, color: "var(--ink-soft)", marginTop: 12 }}>
                {book.author}
              </div>
              <p className="soft" style={{ fontSize: 17, lineHeight: 1.6, marginTop: 20, maxWidth: 620, textWrap: "pretty" }}>
                {book.blurb}
              </p>
              <div className="row" style={{ marginTop: 28 }}>
                <button className="btn btn-mark btn-lg" onClick={() => onChat(book.id)}>
                  <Icon.Chat/> Начать разговор
                </button>
                {inLib ? (
                  <button className="btn btn-ghost btn-lg" disabled style={{ opacity: .7 }}>
                    <Icon.Check/> В библиотеке
                  </button>
                ) : (
                  <button className="btn btn-ghost btn-lg" onClick={() => addBook(book.id)}>
                    <Icon.Plus/> Добавить к себе
                  </button>
                )}
              </div>
              <div className="row" style={{ marginTop: 28, gap: 8, flexWrap: "wrap" }}>
                {(book.genre || []).map((g) => <div key={g} className="badge">{g}</div>)}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Анализ-витрина */}
      <div className="container-narrow" style={{ paddingTop: 72, paddingBottom: 96 }}>
        <div className="mono" style={{ color: "var(--mark)", marginBottom: 16, textAlign: "center" }}>
          Анализ · AI-разбор
        </div>
        <h2 style={{ fontSize: 40, textAlign: "center", letterSpacing: "-0.02em", marginBottom: 48, textWrap: "balance" }}>
          Краткий разбор книги
        </h2>

        {/* Описание */}
        <section className="stack">
          <div className="mono" style={{ color: "var(--ink-muted)" }}>i · Описание</div>
          <h3 style={{ fontSize: 28, letterSpacing: "-0.015em" }}>О чём эта книга</h3>
          <p style={{ fontFamily: "var(--f-serif)", fontSize: 19, lineHeight: 1.6, color: "var(--ink)", textWrap: "pretty" }}>
            {book.summary || book.blurb}
          </p>
        </section>

        <div className="hr" style={{ margin: "56px 0" }}/>

        {/* Ключевая идея */}
        <section className="stack">
          <div className="mono" style={{ color: "var(--ink-muted)" }}>ii · Ключевая идея</div>
          <h3 style={{ fontSize: 28, letterSpacing: "-0.015em" }}>Что говорит автор</h3>
          <div style={{ borderLeft: "3px solid var(--mark)", paddingLeft: 24, marginTop: 8 }}>
            <p style={{ fontFamily: "var(--f-serif)", fontSize: 22, lineHeight: 1.45, fontStyle: "italic", color: "var(--ink)", textWrap: "pretty" }}>
              {book.idea || "Ключевая идея будет сформирована AI после полного анализа книги."}
            </p>
          </div>
          {book.themes && (
            <div style={{ marginTop: 20, display: "flex", gap: 8, flexWrap: "wrap" }}>
              {book.themes.map((t) => <div key={t} className="chip" style={{ cursor: "default" }}>{t}</div>)}
            </div>
          )}
        </section>

        <div className="hr" style={{ margin: "56px 0" }}/>

        {/* Персонажи */}
        <section className="stack">
          <div className="mono" style={{ color: "var(--ink-muted)" }}>iii · Главные персонажи</div>
          <h3 style={{ fontSize: 28, letterSpacing: "-0.015em" }}>Кто движет сюжет</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 18, marginTop: 8 }}>
            {(book.heroes || []).map((h, i) => (
              <div key={h.n} className="card" style={{ padding: 20, background: "var(--cream)" }}>
                <div className="row-sm" style={{ marginBottom: 8 }}>
                  <div style={{ width: 32, height: 32, borderRadius: "50%", background: ["oklch(58% 0.11 60)","oklch(42% 0.11 25)","oklch(28% 0.04 260)","oklch(36% 0.07 150)","oklch(48% 0.09 55)","oklch(60% 0.12 200)"][i % 6], color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--f-serif)", fontSize: 14 }}>{h.n[0]}</div>
                  <div style={{ fontFamily: "var(--f-serif)", fontSize: 17, fontWeight: 500 }}>{h.n}</div>
                </div>
                <p className="soft" style={{ fontSize: 14, lineHeight: 1.5 }}>{h.r}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="hr" style={{ margin: "56px 0" }}/>

        {/* События */}
        <section className="stack">
          <div className="mono" style={{ color: "var(--ink-muted)" }}>iv · Ключевые события</div>
          <h3 style={{ fontSize: 28, letterSpacing: "-0.015em" }}>Сюжет в пяти точках</h3>
          <ol style={{ listStyle: "none", padding: 0, marginTop: 12, counterReset: "e" }}>
            {(book.events || []).map((e, i) => (
              <li key={i} style={{ display: "grid", gridTemplateColumns: "48px 1fr", gap: 20, padding: "18px 0", borderBottom: i < book.events.length - 1 ? "1px solid var(--rule-soft)" : "none" }}>
                <div style={{ fontFamily: "var(--f-serif)", fontSize: 28, color: "var(--mark)", lineHeight: 1 }}>{String(i + 1).padStart(2, "0")}</div>
                <div style={{ fontFamily: "var(--f-serif)", fontSize: 19, lineHeight: 1.5, color: "var(--ink)", paddingTop: 2 }}>{e}</div>
              </li>
            ))}
          </ol>
        </section>

        {/* CTA к чату */}
        <div style={{ marginTop: 72, textAlign: "center", padding: "48px 32px", background: "var(--paper-2)", border: "1px solid var(--rule)", borderRadius: "var(--r-xl)" }}>
          <div className="mono" style={{ color: "var(--mark)", marginBottom: 14 }}>Дальше — вопросы</div>
          <h3 style={{ fontSize: 30, letterSpacing: "-0.015em", textWrap: "balance", maxWidth: 520, margin: "0 auto" }}>
            Хотите спросить о чём-то, чего нет в разборе?
          </h3>
          <p className="soft" style={{ fontSize: 15, marginTop: 14, maxWidth: 460, margin: "14px auto 0", lineHeight: 1.55 }}>
            Откройте чат — AI-эксперт ответит, опираясь на текст книги, и покажет, откуда пришёл ответ.
          </p>
          <button className="btn btn-mark btn-lg" style={{ marginTop: 28 }} onClick={() => onChat(book.id)}>
            <Icon.Chat/> Перейти в чат
          </button>
        </div>
      </div>
    </div>
  );
}

// ===== Chat by single book =====
const SAMPLE_DIALOG = [
  { r: "user", t: "Почему Маргарита согласилась стать королевой бала у Воланда?" },
  {
    r: "ai",
    t: "Не ради почестей, а ради единственного условия — вернуть Мастера. Азазелло находит её в момент, когда она потеряла смысл жить без него, и предлагает сделку, в которой цена — она сама. Маргарита принимает это сознательно: она не жертва, а скорее соучастница, готовая пройти через любое унижение ради любви.",
    cites: [
      { ch: "Глава 19", p: 218, q: "«Невидима и свободна! Невидима и свободна!» — повторяла она, поднимаясь над бульваром." },
      { ch: "Глава 20", p: 231, q: "— Я согласна на всё, — твёрдо сказала Маргарита." },
      { ch: "Глава 22", p: 247, q: "— Вы должны будете исполнить роль королевы..." },
    ],
  },
];

function ScreenChatBook({ bookId, go }) {
  const book = window.REMARKA.BOOKS.find((b) => b.id === bookId) || window.REMARKA.BOOKS[0];
  const [msgs, setMsgs] = useS2(SAMPLE_DIALOG);
  const [draft, setDraft] = useS2("");
  const [typing, setTyping] = useS2(false);
  const [mode, setMode] = useS2("Литературовед");
  const [activeCite, setActiveCite] = useS2(null);
  const scrollRef = useR2(null);

  useE2(() => {
    scrollRef.current?.scrollTo({ top: 999999, behavior: "smooth" });
  }, [msgs, typing]);

  const send = (text) => {
    const t = (text ?? draft).trim();
    if (!t) return;
    setMsgs((m) => [...m, { r: "user", t }]);
    setDraft("");
    setTyping(true);
    setTimeout(() => {
      setTyping(false);
      setMsgs((m) => [...m, {
        r: "ai",
        t: "Воланд не случайно выбирает Москву 1930-х: это общество, которое отменило и религию, и само понятие зла как метафизической категории. Его появление — проверка: если ни Бога, ни дьявола нет, откуда тогда всё происходящее? Булгаков переворачивает атеистический тезис, заставляя героев столкнуться с реальностью того, в существование чего они отказались верить.",
        cites: [
          { ch: "Глава 1", p: 12, q: "— Вы — атеисты?! — ...ответил Берлиоз, вежливо улыбнувшись." },
          { ch: "Глава 3", p: 37, q: "Имейте в виду, что Иисус существовал." },
        ],
      }]);
    }, 1400);
  };

  return (
    <div className="screen-fade" style={{ display: "grid", gridTemplateColumns: "280px 1fr 360px", height: "calc(100vh - 64px)", borderTop: "1px solid var(--rule)" }}>
      {/* Левая колонка — книга */}
      <div style={{ borderRight: "1px solid var(--rule)", padding: 28, background: "var(--paper-2)", overflow: "auto" }}>
        <div style={{ width: 160, margin: "0 auto" }}>
          <BookCover book={book} size="md"/>
        </div>
        <div style={{ textAlign: "center", marginTop: 20 }}>
          <div style={{ fontFamily: "var(--f-serif)", fontSize: 18, lineHeight: 1.25, textWrap: "balance" }}>{book.title}</div>
          <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 8 }}>{book.author}</div>
        </div>
        <div className="hr" style={{ margin: "24px 0" }}/>
        <div className="mono" style={{ color: "var(--ink-faint)", marginBottom: 10 }}>Роль ассистента</div>
        <div className="stack-sm">
          {["Литературовед", "Критик", "Друг-читатель"].map((m) => (
            <div key={m} className={`chip ${mode === m ? "active" : ""}`} onClick={() => setMode(m)} style={{ width: "100%", justifyContent: "space-between" }}>
              <span>{m}</span>
              {mode === m && <Icon.Check2/>}
            </div>
          ))}
        </div>
        <div className="hr" style={{ margin: "24px 0" }}/>
        <button className="btn btn-ghost btn-sm btn-block" onClick={() => go("book", book.id)}>
          <Icon.Book/> Открыть разбор
        </button>
      </div>

      {/* Центр — диалог */}
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ padding: "16px 32px", borderBottom: "1px solid var(--rule)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="row-sm">
            <div className="badge mark"><Icon.Sparkle/> Эксперт по книге</div>
            <span className="mono" style={{ color: "var(--ink-muted)" }}>{mode}</span>
          </div>
          <div className="row-sm">
            <button className="btn btn-plain btn-sm"><Icon.Bookmark/> Сохранить</button>
            <button className="btn btn-plain btn-sm">Экспорт</button>
          </div>
        </div>

        <div ref={scrollRef} style={{ flex: 1, overflow: "auto", padding: "32px 48px" }}>
          <div style={{ maxWidth: 720, margin: "0 auto" }} className="stack-xl">
            {msgs.map((m, i) => (
              <MsgBubble key={i} m={m} onCite={setActiveCite}/>
            ))}
            {typing && <Typing/>}
          </div>
        </div>

        <div style={{ padding: "20px 48px 28px" }}>
          <div style={{ maxWidth: 720, margin: "0 auto" }}>
            {msgs.length < 2 && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                {window.REMARKA.SUGGESTED_PROMPTS_BOOK.map((p) => (
                  <button key={p} className="sug" onClick={() => send(p)}>
                    <span className="k">вопрос</span>{p}
                  </button>
                ))}
              </div>
            )}
            <div style={{ position: "relative", background: "var(--cream)", border: "1px solid var(--rule)", borderRadius: "var(--r-lg)", padding: "14px 18px", boxShadow: "var(--shadow-sm)" }}>
              <textarea className="textarea" rows={2} value={draft} onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder={`Спросите что-нибудь о «${book.title}»…`}
                style={{ border: "none", background: "transparent", padding: 0, boxShadow: "none" }}/>
              <div className="row" style={{ justifyContent: "space-between", marginTop: 10 }}>
                <div className="mono" style={{ color: "var(--ink-faint)" }}>↵ отправить · ⇧↵ перенос</div>
                <button className="btn btn-mark btn-sm" onClick={() => send()} disabled={!draft.trim()} style={{ opacity: draft.trim() ? 1 : 0.5 }}>
                  <Icon.Send/> Отправить
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Правая колонка — источник */}
      <div style={{ borderLeft: "1px solid var(--rule)", padding: 28, background: "var(--paper-2)", overflow: "auto" }}>
        <div className="mono" style={{ color: "var(--mark)", marginBottom: 10 }}>Источник</div>
        {activeCite ? (
          <div>
            <div style={{ fontFamily: "var(--f-serif)", fontSize: 18 }}>{activeCite.ch}</div>
            <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 4 }}>Страница {activeCite.p}</div>
            <div style={{ marginTop: 20, padding: 18, background: "var(--cream)", border: "1px solid var(--rule)", borderRadius: "var(--r)", fontFamily: "var(--f-serif)", fontSize: 15, lineHeight: 1.65 }}>
              <span style={{ color: "var(--mark)", fontFamily: "var(--f-serif)", fontSize: 28, lineHeight: 0, position: "relative", top: 10, marginRight: 4 }}>«</span>
              {activeCite.q}
              <span style={{ color: "var(--mark)", fontFamily: "var(--f-serif)", fontSize: 28, lineHeight: 0, position: "relative", top: 10, marginLeft: 2 }}>»</span>
            </div>
            <button className="btn btn-ghost btn-sm btn-block" style={{ marginTop: 16 }}>
              <Icon.Book/> Открыть в книге
            </button>
          </div>
        ) : (
          <div className="soft" style={{ fontSize: 13, lineHeight: 1.6 }}>
            AI-эксперт подкрепляет ответы цитатами из книги. Нажмите на ссылку под ответом —
            и здесь откроется точное место в тексте.
          </div>
        )}
      </div>
    </div>
  );
}

function MsgBubble({ m, onCite }) {
  if (m.r === "user") {
    return (
      <div style={{ textAlign: "right" }}>
        <div className="mono" style={{ color: "var(--ink-faint)", marginBottom: 6 }}>Вы</div>
        <div style={{ display: "inline-block", maxWidth: "85%", padding: "14px 18px", background: "var(--ink)", color: "var(--paper)", borderRadius: "var(--r-lg)", borderTopRightRadius: 4, fontSize: 15, textAlign: "left", lineHeight: 1.5 }}>
          {m.t}
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "36px 1fr", gap: 16 }}>
      <div style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--mark-soft)", color: "var(--mark)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Icon.Sparkle/>
      </div>
      <div>
        <div className="mono" style={{ color: "var(--mark)", marginBottom: 8 }}>Ремарка</div>
        <div style={{ fontFamily: "var(--f-serif)", fontSize: 17, lineHeight: 1.6, color: "var(--ink)", textWrap: "pretty" }}>
          {m.t}
        </div>
        {m.cites && (
          <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {m.cites.map((c, i) => (
              <button key={i} className="badge" onClick={() => onCite(c)} style={{ cursor: "pointer" }}>
                <Icon.Quote/> {c.ch} · стр. {c.p}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Typing() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "36px 1fr", gap: 16 }}>
      <div style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--mark-soft)", color: "var(--mark)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Icon.Sparkle/>
      </div>
      <div style={{ paddingTop: 12 }}>
        <div className="mono" style={{ color: "var(--mark)", marginBottom: 8 }}>Ремарка ищет в тексте…</div>
        <div style={{ display: "inline-flex", gap: 4 }}>
          {[0, 1, 2].map((i) => (
            <span key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--mark)", animation: `dot 1.2s ${i * 0.15}s infinite ease-in-out` }}/>
          ))}
        </div>
        <style>{`@keyframes dot { 0%, 80%, 100% { opacity: .3; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-3px); } }`}</style>
      </div>
    </div>
  );
}

Object.assign(window, { ScreenBook, ScreenChatBook });
