// remarka — экраны: Landing, Catalog

const { useState: useState_s, useMemo: useMemo_s } = React;

// ===== Landing =====
function ScreenLanding({ go, onSignIn }) {
  return (
    <div className="screen-fade">
      {/* Hero */}
      <div className="container" style={{ paddingTop: 64, paddingBottom: 64 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 64, alignItems: "center" }}>
          <div>
            <div className="mono" style={{ color: "var(--mark)", marginBottom: 24 }}>№ 001 · AI-чтение</div>
            <h1 style={{ fontSize: 68, lineHeight: 1.02, letterSpacing: "-0.025em", textWrap: "balance" }}>
              Разговор с книгой,<br/>
              как с автором, <span style={{ fontStyle: "italic", color: "var(--mark)" }}>лично</span>.
            </h1>
            <p className="soft" style={{ fontSize: 18, lineHeight: 1.55, marginTop: 28, maxWidth: 520, textWrap: "pretty" }}>
              Ремарка читает книгу за вас — и остаётся рядом, чтобы ответить на сложные вопросы,
              найти цитату, сравнить героев и свести всю вашу библиотеку в один диалог.
            </p>
            <div className="row" style={{ marginTop: 36 }}>
              <button className="btn btn-mark btn-lg" onClick={() => go("catalog")}>
                Открыть каталог <Icon.Arrow/>
              </button>
              <button className="btn btn-ghost btn-lg" onClick={() => go("upload")}>
                <Icon.Upload/> Загрузить свою книгу
              </button>
            </div>
            <div className="row" style={{ marginTop: 48, gap: 32 }}>
              <div>
                <div style={{ fontFamily: "var(--f-serif)", fontSize: 32, fontWeight: 500 }}>98<span style={{ color: "var(--mark)" }}>.</span></div>
                <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 4 }}>Каталог открыт</div>
              </div>
              <div className="hr-v" style={{ height: 44 }}/>
              <div>
                <div style={{ fontFamily: "var(--f-serif)", fontSize: 32, fontWeight: 500 }}>EPUB · FB2 · PDF</div>
                <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 4 }}>Форматы загрузки</div>
              </div>
            </div>
          </div>
          {/* Hero art: книжная полка с отсылкой-ремаркой */}
          <HeroArt/>
        </div>
      </div>

      {/* Принципы */}
      <div className="hr"/>
      <div className="container" style={{ paddingTop: 72, paddingBottom: 72 }}>
        <SectionHead eyebrow="Как это устроено" title="Четыре разворота"/>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 32 }}>
          {[
            { n: "i", t: "Каталог", d: "Сто книг — от Достоевского до Канемана. Открываете страницу книги и сразу видите анализ.", action: () => go("catalog"), al: "В каталог" },
            { n: "ii", t: "Анализ-витрина", d: "Описание, ключевая идея, герои, события — на одной странице, как авторский разбор.", action: () => go("book"), al: "Пример разбора" },
            { n: "iii", t: "Диалог с книгой", d: "AI-эксперт отвечает с цитатами и ссылками на страницы — ни слова без источника.", action: () => go("chat-book"), al: "Открыть чат" },
            { n: "iv", t: "Вся библиотека", d: "Загрузите свои книги и задавайте вопросы сразу по всей полке.", action: () => go("library"), al: "Мои книги" },
          ].map((it) => (
            <div key={it.n} className="stack-sm" style={{ paddingRight: 24 }}>
              <div className="mono" style={{ color: "var(--mark)", fontSize: 10 }}>{it.n}</div>
              <h3 style={{ fontSize: 22, marginTop: 4, marginBottom: 4 }}>{it.t}</h3>
              <p className="soft" style={{ fontSize: 14, lineHeight: 1.55 }}>{it.d}</p>
              <button className="btn btn-plain btn-sm" style={{ paddingLeft: 0, marginTop: 8 }} onClick={it.action}>
                {it.al} <Icon.Arrow/>
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Пример чата */}
      <div style={{ background: "var(--paper-2)", borderTop: "1px solid var(--rule)", borderBottom: "1px solid var(--rule)" }}>
        <div className="container" style={{ paddingTop: 80, paddingBottom: 80 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1.1fr", gap: 64, alignItems: "center" }}>
            <div>
              <div className="mono" style={{ color: "var(--mark)", marginBottom: 16 }}>Пример</div>
              <h2 style={{ fontSize: 40, letterSpacing: "-0.02em", lineHeight: 1.1, textWrap: "balance" }}>
                Задайте вопрос, на который страница <span style={{ fontStyle: "italic" }}>не отвечает прямо</span>.
              </h2>
              <p className="soft" style={{ fontSize: 16, lineHeight: 1.6, marginTop: 18, maxWidth: 440 }}>
                Каждое утверждение модель подкрепляет цитатой с точным местом в книге. Вы видите, откуда пришёл ответ —
                и можете открыть это место одним кликом.
              </p>
              <button className="btn btn-primary btn-lg" style={{ marginTop: 28 }} onClick={() => go("chat-book")}>
                Попробовать на «Мастере и Маргарите» <Icon.Arrow/>
              </button>
            </div>
            <LandingChatDemo/>
          </div>
        </div>
      </div>

      {/* Библиотека превью */}
      <div className="container" style={{ paddingTop: 80, paddingBottom: 80 }}>
        <SectionHead eyebrow="В каталоге" title="Свежие разборы"
          right={<button className="btn btn-ghost btn-sm" onClick={() => go("catalog")}>Все книги <Icon.Arrow/></button>}/>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 24 }}>
          {window.REMARKA.BOOKS.slice(0, 6).map((b) => (
            <BookCard key={b.id} book={b} onClick={() => go("book", b.id)}/>
          ))}
        </div>
      </div>

      {/* Футер */}
      <div style={{ borderTop: "1px solid var(--rule)", background: "var(--paper-2)" }}>
        <div className="container" style={{ paddingTop: 56, paddingBottom: 56 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 48, flexWrap: "wrap" }}>
            <div>
              <div className="logo" style={{ fontSize: 28 }}>ремарка<span className="dot">.</span></div>
              <p className="muted" style={{ fontSize: 13, marginTop: 12, maxWidth: 320 }}>
                Литературный AI-сервис. На полях любой книги — ваш экземпляр с пометками, к которому можно вернуться.
              </p>
            </div>
            <div className="row-lg" style={{ fontSize: 13 }}>
              <a className="nav-link">Каталог</a>
              <a className="nav-link">Блог</a>
              <a className="nav-link">Правовая информация</a>
              <a className="nav-link">Поддержка</a>
            </div>
          </div>
          <div className="hr" style={{ marginTop: 32, marginBottom: 18 }}/>
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <div className="mono" style={{ color: "var(--ink-faint)" }}>© 2026 remarka · Made for readers</div>
            <div className="mono" style={{ color: "var(--ink-faint)" }}>Сделано для читателей</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function HeroArt() {
  // Композиция из трёх обложек + редакторская ремарка
  const b = window.REMARKA.BOOKS;
  return (
    <div style={{ position: "relative", height: 520 }}>
      <div style={{ position: "absolute", left: 0, top: 40, width: 200, transform: "rotate(-6deg)" }}>
        <BookCover book={b[2]} size="lg"/>
      </div>
      <div style={{ position: "absolute", left: 140, top: 0, width: 240, zIndex: 2 }}>
        <BookCover book={b[0]} size="lg"/>
      </div>
      <div style={{ position: "absolute", right: 0, top: 60, width: 200, transform: "rotate(5deg)" }}>
        <BookCover book={b[6]} size="lg"/>
      </div>
      {/* Pen mark */}
      <div style={{ position: "absolute", left: 220, top: 240, zIndex: 4, pointerEvents: "none" }}>
        <svg width="280" height="120" viewBox="0 0 280 120" fill="none">
          <path d="M 10 60 C 60 20, 120 90, 200 50 S 270 70, 270 70" stroke="var(--mark)" strokeWidth="3" strokeLinecap="round" fill="none" style={{ strokeDasharray: 400, strokeDashoffset: 0, filter: "drop-shadow(0 1px 0 oklch(52% 0.18 25 / 0.3))" }}/>
        </svg>
      </div>
      {/* Ремарка-записка */}
      <div style={{ position: "absolute", right: -10, bottom: 10, width: 220, background: "var(--cream)", border: "1px solid var(--rule)", borderRadius: "var(--r-lg)", padding: 16, boxShadow: "var(--shadow)", transform: "rotate(3deg)", zIndex: 5 }}>
        <div className="mono" style={{ color: "var(--mark)", fontSize: 9, marginBottom: 8 }}>Ремарка AI · стр. 247</div>
        <div style={{ fontFamily: "var(--f-serif)", fontSize: 14, lineHeight: 1.4, color: "var(--ink)" }}>
          «Трусость — самый страшный порок», — говорит Иешуа. Это не случайная фраза, а камертон всего романа.
        </div>
      </div>
    </div>
  );
}

function LandingChatDemo() {
  return (
    <div className="card" style={{ padding: 28, boxShadow: "var(--shadow-lg)" }}>
      <div className="row" style={{ marginBottom: 20 }}>
        <BookCover book={window.REMARKA.BOOKS[0]} size="sm"/>
        <div style={{ marginLeft: 12 }}>
          <div style={{ fontFamily: "var(--f-serif)", fontSize: 16 }}>Мастер и Маргарита</div>
          <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 2 }}>Михаил Булгаков · 480 стр.</div>
        </div>
      </div>

      <div style={{ background: "var(--paper)", borderRadius: "var(--r)", padding: "14px 16px", border: "1px solid var(--rule)" }}>
        <div className="mono" style={{ color: "var(--ink-faint)", marginBottom: 6 }}>Вы</div>
        <div style={{ fontSize: 14, color: "var(--ink)" }}>Почему Маргарита согласилась стать королевой бала?</div>
      </div>

      <div style={{ marginTop: 16, paddingLeft: 18, borderLeft: "2px solid var(--mark)" }}>
        <div className="mono" style={{ color: "var(--mark)", marginBottom: 8 }}>Ремарка</div>
        <div style={{ fontFamily: "var(--f-serif)", fontSize: 15, lineHeight: 1.55, color: "var(--ink)" }}>
          Не ради величия, а ради надежды: Азазелло обещает вернуть Мастера. Маргарита — женщина, у которой отняли смысл,
          и она соглашается на любое испытание, только бы его обрести обратно.
        </div>
        <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <div className="badge mark"><Icon.Quote/> гл. 19 · стр. 218</div>
          <div className="badge"><Icon.Quote/> гл. 20 · стр. 231</div>
          <div className="badge"><Icon.Quote/> гл. 22 · стр. 247</div>
        </div>
      </div>
    </div>
  );
}

// ===== Catalog =====
function ScreenCatalog({ go, addBook, owned }) {
  const [q, setQ] = useState_s("");
  const [cat, setCat] = useState_s("Все жанры");
  const [sort, setSort] = useState_s("Популярные");

  const books = useMemo_s(() => {
    let list = window.REMARKA.BOOKS;
    if (cat !== "Все жанры") list = list.filter((b) => (b.genre || []).includes(cat) || b.tag === cat);
    if (q) {
      const s = q.toLowerCase();
      list = list.filter((b) => b.title.toLowerCase().includes(s) || b.author.toLowerCase().includes(s));
    }
    return list;
  }, [q, cat]);

  return (
    <div className="screen-fade">
      <div className="container" style={{ paddingTop: 48, paddingBottom: 24 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 24 }}>
          <div>
            <div className="mono" style={{ color: "var(--mark)", marginBottom: 12 }}>Каталог · 98 книг</div>
            <h1 style={{ fontSize: 48, letterSpacing: "-0.02em", lineHeight: 1.05 }}>Открытая библиотека</h1>
            <p className="soft" style={{ fontSize: 16, marginTop: 14, maxWidth: 560, lineHeight: 1.55 }}>
              Курируемая коллекция книг с готовым разбором и чатом. Откройте любую — и задайте вопрос.
            </p>
          </div>
          <div style={{ position: "relative", width: 340 }}>
            <Icon.Search style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--ink-faint)" }}/>
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Название или автор" style={{ paddingLeft: 40 }}/>
          </div>
        </div>

        <div className="hr" style={{ marginTop: 36, marginBottom: 20 }}/>

        {/* фильтры: жанры, затем счётчик + сортировка-селект */}
        <div className="catalog-filters">
          <div className="catalog-chips">
            <ChipGroup items={window.REMARKA.CATEGORIES} active={cat} onPick={setCat}/>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginTop: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <label style={{ fontSize: 13, color: "var(--ink-muted)" }}>Сортировка:</label>
              <div style={{ position: "relative" }}>
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                  style={{
                    appearance: "none",
                    WebkitAppearance: "none",
                    MozAppearance: "none",
                    padding: "8px 36px 8px 14px",
                    fontSize: 13,
                    fontFamily: "inherit",
                    color: "var(--ink)",
                    background: "var(--paper-2)",
                    border: "1px solid var(--rule)",
                    borderRadius: 100,
                    cursor: "pointer",
                    outline: "none",
                  }}
                >
                  {["Популярные", "Новые", "По алфавиту"].map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", color: "var(--ink-muted)", pointerEvents: "none" }}><path d="m6 9 6 6 6-6"/></svg>
              </div>
            </div>
            <span className="mono" style={{ color: "var(--ink-faint)", fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase" }}>
              {books.length} {books.length === 1 ? "книга" : books.length < 5 ? "книги" : "книг"}
            </span>
          </div>
        </div>
      </div>

      <div className="container" style={{ paddingTop: 32, paddingBottom: 96 }}>
        {books.length === 0 ? (
          <div style={{ textAlign: "center", padding: "64px 0" }}>
            <h3 style={{ fontSize: 22 }}>Ничего не нашлось</h3>
            <p className="muted" style={{ marginTop: 8 }}>Попробуйте загрузить книгу сами — мы её разберём.</p>
            <button className="btn btn-mark" style={{ marginTop: 20 }} onClick={() => go("upload")}>
              <Icon.Upload/> Загрузить книгу
            </button>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 32, rowGap: 44 }}>
            {books.map((b) => (
              <BookCard key={b.id} book={b} owned={owned.has(b.id)} onClick={() => go("book", b.id)}/>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { ScreenLanding, ScreenCatalog });
