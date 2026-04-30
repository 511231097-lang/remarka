// remarka — экраны: Library, ChatLibrary, Upload, Profile

const { useState: useS3, useEffect: useE3, useRef: useR3 } = React;

// ===== My Library =====
function ScreenLibrary({ go, owned, removeBook, onChat, analyzing, plan = "free", onUpgrade }) {
  const isPlus = plan === "plus";
  const myBooks = window.REMARKA.BOOKS.filter((b) => owned.has(b.id));
  const analyzingList = isPlus ? analyzing : [];
  const total = myBooks.length + analyzingList.length;

  return (
    <div className="screen-fade">
      <div className="container" style={{ paddingTop: 48, paddingBottom: 24 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 24 }}>
          <div>
            <div className="mono" style={{ color: "var(--mark)", marginBottom: 12 }}>Моя библиотека · {total} {declension(total, ["книга", "книги", "книг"])}</div>
            <h1 style={{ fontSize: 48, letterSpacing: "-0.02em", lineHeight: 1.05 }}>Ваша полка</h1>
            <p className="soft" style={{ fontSize: 16, marginTop: 14, maxWidth: 560, lineHeight: 1.55 }}>
              Все книги, которые вы сохранили{isPlus ? " или загрузили" : ""}. Откройте любую — и задайте вопрос по одной книге.
            </p>
          </div>
          <div className="row-sm">
            <button className="btn btn-ghost" onClick={() => go("upload")}>
              <Icon.Upload/> Загрузить книгу
              {!isPlus && <span className="lock-pill">Плюс</span>}
            </button>
            <button className="btn btn-mark" onClick={() => go("chat")}>
              <Icon.Chat/> Открыть чат
            </button>
          </div>
        </div>

        {!isPlus && myBooks.length > 0 && (
          <div className="upsell-bar">
            <div className="upsell-icon"><Icon.Sparkle/></div>
            <div className="upsell-copy">
              <div className="upsell-t">Загружайте свои книги на тарифе Плюс</div>
              <div className="upsell-s">EPUB, FB2, PDF — и полный AI-разбор по каждой. Каталог и чат остаются бесплатными.</div>
            </div>
            <button className="btn btn-mark btn-sm" onClick={onUpgrade}>Перейти на Плюс</button>
          </div>
        )}

        <div className="hr" style={{ marginTop: 36, marginBottom: 32 }}/>

        {total === 0 ? (
          <EmptyLibrary go={go} plan={plan} onUpgrade={onUpgrade}/>
        ) : (
          <>
            {analyzingList.length > 0 && (
              <>
                <div className="row" style={{ justifyContent: "space-between", marginBottom: 20 }}>
                  <div className="mono" style={{ color: "var(--bronze)" }}>Анализируется · {analyzingList.length}</div>
                  <div className="mono" style={{ color: "var(--ink-faint)" }}>Обычно 1–3 минуты</div>
                </div>
                <div className="library-grid" style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 32, rowGap: 44 }}>
                  {analyzingList.map((b) => <AnalyzingCard key={b.id} book={b}/>)}
                </div>
                <div className="hr" style={{ margin: "48px 0 32px" }}/>
              </>
            )}

            {myBooks.length > 0 && (
              <>
                <div className="mono" style={{ color: "var(--ink-muted)", marginBottom: 20 }}>Готовы к чтению · {myBooks.length}</div>
                <div className="library-grid" style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 32, rowGap: 44 }}>
                  {myBooks.map((b) => (
                    <LibraryCard key={b.id} book={b} onOpen={() => go("book", b.id)} onChat={() => onChat(b.id)} onRemove={() => removeBook(b.id)}/>
                  ))}
                </div>
              </>
            )}
            <style>{`@keyframes pulse { 0%, 100% { opacity: .4; } 50% { opacity: 1; } }`}</style>
          </>
        )}
      </div>

      <div style={{ height: 96 }}/>
    </div>
  );
}

function AnalyzingCard({ book }) {
  const stages = [
    { max: 25, label: "Извлечение текста" },
    { max: 55, label: "Разбивка на фрагменты" },
    { max: 85, label: "Индексация для поиска" },
    { max: 100, label: "Сборка разбора" },
  ];
  const p = book.progress ?? 0;
  const stage = stages.find((s) => p <= s.max) || stages[stages.length - 1];
  return (
    <div className="book-card" style={{ cursor: "default" }}>
      <div style={{ position: "relative" }}>
        <div style={{ opacity: 0.55 }}><BookCover book={book}/></div>
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: 10 }}>
          <div style={{ background: "var(--cream)", border: "1px solid var(--rule)", borderRadius: "var(--r)", padding: "8px 10px", boxShadow: "var(--shadow-sm)" }}>
            <div className="row-sm" style={{ justifyContent: "space-between", marginBottom: 6 }}>
              <span className="mono" style={{ fontSize: 9, color: "var(--bronze)" }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--bronze)", display: "inline-block", marginRight: 5, animation: "pulse 1.5s infinite", verticalAlign: "middle" }}/>
                {p}%
              </span>
              <span className="mono" style={{ fontSize: 9, color: "var(--ink-muted)" }}>{book.eta || "~2 мин"}</span>
            </div>
            <div style={{ height: 3, background: "var(--paper-2)", borderRadius: 100, overflow: "hidden" }}>
              <div style={{ width: `${p}%`, height: "100%", background: "var(--bronze)", transition: "width .3s" }}/>
            </div>
            <div style={{ fontSize: 10, color: "var(--ink-muted)", marginTop: 6 }}>{stage.label}…</div>
          </div>
        </div>
      </div>
      <div className="meta">
        <div className="t">{book.title}</div>
        <div className="a">{book.author} · {book.format || "EPUB"}</div>
      </div>
    </div>
  );
}

function LibraryCard({ book, onOpen, onChat, onRemove }) {
  return (
    <div className="book-card" style={{ position: "relative" }}>
      <div onClick={onOpen}>
        <BookCover book={book}/>
      </div>
      <div className="meta">
        <div className="t" onClick={onOpen} style={{ cursor: "pointer" }}>{book.title}</div>
        <div className="a">{book.author}</div>
      </div>
      <div className="row-sm" style={{ marginTop: 10 }}>
        <button className="btn btn-ghost btn-sm" onClick={onChat}><Icon.Chat/> Чат</button>
        <button className="btn btn-plain btn-sm" onClick={onRemove} title="Убрать">×</button>
      </div>
    </div>
  );
}

function EmptyLibrary({ go, plan = "free", onUpgrade }) {
  const isPlus = plan === "plus";
  return (
    <div style={{ textAlign: "center", padding: "72px 0" }}>
      <div style={{ fontFamily: "var(--f-serif)", fontSize: 52, color: "var(--ink-faint)" }}>—</div>
      <h3 style={{ fontSize: 28, marginTop: 16 }}>Полка пока пуста</h3>
      <p className="soft" style={{ fontSize: 15, marginTop: 10, maxWidth: 420, margin: "10px auto 0" }}>
        {isPlus
          ? "Добавьте книгу из каталога или загрузите собственную — в EPUB, FB2 или PDF."
          : "Добавьте книгу из каталога. Загрузка своих книг откроется на тарифе Плюс."}
      </p>
      <div className="row" style={{ justifyContent: "center", marginTop: 28 }}>
        <button className="btn btn-ghost" onClick={() => go("catalog")}><Icon.Library/> В каталог</button>
        {isPlus ? (
          <button className="btn btn-mark" onClick={() => go("upload")}><Icon.Upload/> Загрузить</button>
        ) : (
          <button className="btn btn-mark" onClick={onUpgrade}><Icon.Sparkle/> Перейти на Плюс</button>
        )}
      </div>
    </div>
  );
}

function declension(n, forms) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

// ===== Chat with whole library — REMOVED. См. screens-chat.jsx (только по одной книге) =====
function ScreenChatLib_DEPRECATED({ go, owned, onBook }) {
  return null;
}

// eslint-disable-next-line
function _LIB_OLD_UNUSED_NEVER_RENDERED({ go, owned, onBook }) {
  return null;
  // legacy code removed — chat is per-book only now
  /* eslint-disable */
  const [msgs, setMsgs] = useS3([]);
  const [draft, setDraft] = useS3("");
  const [typing, setTyping] = useS3(false);
  const scrollRef = useR3(null);
  const myBooks = window.REMARKA.BOOKS.filter((b) => owned.has(b.id));

  useE3(() => { scrollRef.current?.scrollTo({ top: 999999, behavior: "smooth" }); }, [msgs, typing]);

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
        t: "В ваших книгах тема одиночества звучит очень по-разному. У Толстого это одиночество в толпе — Анна среди гостей и мужа, который её не видит. У Достоевского — добровольная изоляция идеи: Раскольников отгораживается от матери и сестры, чтобы «додумать» теорию до конца. Это не одно и то же одиночество, а два разных устройства.",
        multi: [
          { bookId: "anna", cites: [{ ch: "Часть 1, гл. 30", p: 98 }] },
          { bookId: "crime", cites: [{ ch: "Часть 3, гл. 5", p: 236 }] },
        ],
      }]);
    }, 1500);
  };

  return (
    <div className="screen-fade" style={{ display: "grid", gridTemplateColumns: "320px 1fr", height: "calc(100vh - 64px)", borderTop: "1px solid var(--rule)" }}>
      {/* Левый столбец — вся библиотека */}
      <div style={{ borderRight: "1px solid var(--rule)", padding: 24, background: "var(--paper-2)", overflow: "auto" }}>
        <div className="mono" style={{ color: "var(--mark)", marginBottom: 14 }}>В разговоре · {myBooks.length + 1} {declension(myBooks.length + 1, ["книга", "книги", "книг"])}</div>
        <h3 style={{ fontSize: 20, marginBottom: 18 }}>Ваша библиотека</h3>
        <div className="stack-sm">
          {myBooks.map((b) => (
            <div key={b.id} className="row" style={{ padding: 10, borderRadius: "var(--r)", background: "var(--cream)", border: "1px solid var(--rule)", cursor: "pointer" }} onClick={() => onBook(b.id)}>
              <div style={{ width: 40, flexShrink: 0 }}><BookCover book={b} size="sm"/></div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: "var(--f-serif)", fontSize: 14, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.title}</div>
                <div style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 2 }}>{b.author}</div>
              </div>
            </div>
          ))}
          <div className="row" style={{ padding: 10, borderRadius: "var(--r)", background: "var(--cream)", border: "1px dashed var(--rule)" }}>
            <div style={{ width: 40, height: 60, background: "var(--paper-2)", border: "1px solid var(--rule)", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-muted)" }}>
              <Icon.Book/>
            </div>
            <div>
              <div style={{ fontFamily: "var(--f-serif)", fontSize: 14 }}>Заметки о Ясной Поляне</div>
              <div style={{ fontSize: 11, color: "var(--bronze)", marginTop: 2 }}>Обрабатывается…</div>
            </div>
          </div>
        </div>
        <button className="btn btn-ghost btn-sm btn-block" style={{ marginTop: 16 }} onClick={() => go("upload")}>
          <Icon.Plus/> Добавить книгу
        </button>
      </div>

      {/* Чат */}
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ padding: "16px 32px", borderBottom: "1px solid var(--rule)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="row-sm">
            <div className="badge mark"><Icon.Library/> Разговор по всей полке</div>
          </div>
          <div className="mono" style={{ color: "var(--ink-muted)" }}>AI сам найдёт нужную книгу</div>
        </div>

        <div ref={scrollRef} style={{ flex: 1, overflow: "auto", padding: "32px 48px" }}>
          <div style={{ maxWidth: 760, margin: "0 auto" }} className="stack-xl">
            {msgs.map((m, i) => (
              m.r === "user" ? (
                <div key={i} style={{ textAlign: "right" }}>
                  <div className="mono" style={{ color: "var(--ink-faint)", marginBottom: 6 }}>Вы</div>
                  <div style={{ display: "inline-block", maxWidth: "80%", padding: "14px 18px", background: "var(--ink)", color: "var(--paper)", borderRadius: "var(--r-lg)", borderTopRightRadius: 4, fontSize: 15, textAlign: "left", lineHeight: 1.5 }}>{m.t}</div>
                </div>
              ) : <LibMsg key={i} m={m} onBook={onBook}/>
            ))}
            {typing && <Typing/>}
          </div>
        </div>

        <div style={{ padding: "20px 48px 28px" }}>
          <div style={{ maxWidth: 760, margin: "0 auto" }}>
            {msgs.length < 2 && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                {window.REMARKA.SUGGESTED_PROMPTS_LIB.map((p) => (
                  <button key={p} className="sug" onClick={() => send(p)}>
                    <span className="k">вопрос</span>{p}
                  </button>
                ))}
              </div>
            )}
            <div style={{ background: "var(--cream)", border: "1px solid var(--rule)", borderRadius: "var(--r-lg)", padding: "14px 18px", boxShadow: "var(--shadow-sm)" }}>
              <textarea className="textarea" rows={2} value={draft} onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="Спросите что-нибудь по всей библиотеке…"
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
    </div>
  );
}

function LibMsg({ m, onBook }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "36px 1fr", gap: 16 }}>
      <div style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--mark-soft)", color: "var(--mark)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Icon.Sparkle/>
      </div>
      <div>
        <div className="mono" style={{ color: "var(--mark)", marginBottom: 8 }}>Ремарка · по библиотеке</div>
        <div style={{ fontFamily: "var(--f-serif)", fontSize: 17, lineHeight: 1.6, color: "var(--ink)" }}>{m.t}</div>
        {m.multi && (
          <div className="stack-sm" style={{ marginTop: 16 }}>
            {m.multi.map((item, i) => {
              const book = window.REMARKA.BOOKS.find((b) => b.id === item.bookId);
              if (!book) return null;
              return (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "48px 1fr", gap: 14, padding: 14, background: "var(--paper-2)", border: "1px solid var(--rule)", borderRadius: "var(--r)", cursor: "pointer" }} onClick={() => onBook(book.id)}>
                  <div style={{ width: 48 }}><BookCover book={book} size="sm"/></div>
                  <div>
                    <div style={{ fontFamily: "var(--f-serif)", fontSize: 15 }}>{book.title}</div>
                    <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 4 }}>{book.author}</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                      {item.cites.map((c, j) => (
                        <span key={j} className="badge"><Icon.Quote/> {c.ch} · стр. {c.p}</span>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ===== Upload =====
function ScreenUpload({ go }) {
  const [step, setStep] = useS3(0); // 0 выбор, 1 согласия, 2 обработка, 3 готово
  const [file, setFile] = useS3(null);
  const [consents, setConsents] = useS3({ rights: false, license: false, process: false });
  const [progress, setProgress] = useS3(0);

  useE3(() => {
    if (step !== 2) return;
    const id = setInterval(() => {
      setProgress((p) => {
        if (p >= 100) { clearInterval(id); setStep(3); return 100; }
        return p + 4;
      });
    }, 120);
    return () => clearInterval(id);
  }, [step]);

  const pick = () => {
    setFile({ name: "tolstoy-yasnaya-polyana.epub", size: "2.3 МБ", format: "EPUB" });
    setStep(1);
  };

  return (
    <div className="screen-fade">
      <div className="container-narrow" style={{ paddingTop: 56, paddingBottom: 96 }}>
        <div className="mono" style={{ color: "var(--mark)", marginBottom: 16 }}>Загрузка · шаг {Math.min(step + 1, 3)} из 3</div>
        <h1 style={{ fontSize: 44, letterSpacing: "-0.02em", lineHeight: 1.05 }}>
          {step === 0 && "Добавить собственную книгу"}
          {step === 1 && "Небольшие согласия"}
          {step === 2 && "Ремарка читает книгу"}
          {step === 3 && "Готово — книга в библиотеке"}
        </h1>

        <div style={{ marginTop: 40 }}>
          {step === 0 && (
            <div>
              <div className="card" style={{ padding: 48, textAlign: "center", border: "2px dashed var(--rule)", background: "var(--paper-2)" }}>
                <div style={{ fontFamily: "var(--f-serif)", fontSize: 28, color: "var(--ink)" }}>Перетащите файл сюда</div>
                <div className="soft" style={{ fontSize: 14, marginTop: 8 }}>или нажмите, чтобы выбрать</div>
                <button className="btn btn-mark btn-lg" style={{ marginTop: 24 }} onClick={pick}>
                  <Icon.Upload/> Выбрать файл
                </button>
                <div className="row" style={{ justifyContent: "center", marginTop: 24, gap: 12 }}>
                  {["EPUB", "FB2", "PDF"].map((f) => <div key={f} className="badge">{f}</div>)}
                  <span className="mono" style={{ color: "var(--ink-faint)" }}>до 50 МБ</span>
                </div>
              </div>
              <p className="soft" style={{ fontSize: 13, marginTop: 20, lineHeight: 1.6 }}>
                После загрузки Ремарка построит разбор и сделает книгу доступной для чата.
                Обработка занимает 1–3 минуты на книгу объёмом 400 страниц.
              </p>
            </div>
          )}

          {step === 1 && (
            <div>
              <div className="card" style={{ padding: 24 }}>
                <div className="row">
                  <div style={{ width: 48, height: 64, background: "var(--paper-2)", border: "1px solid var(--rule)", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-muted)" }}>
                    <Icon.Book/>
                  </div>
                  <div>
                    <div style={{ fontFamily: "var(--f-serif)", fontSize: 17 }}>{file.name}</div>
                    <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 4 }}>{file.format} · {file.size}</div>
                  </div>
                </div>
              </div>

              <div className="stack-lg" style={{ marginTop: 28 }}>
                <ConsentRow checked={consents.rights} onChange={(v) => setConsents((c) => ({ ...c, rights: v }))}
                  label="Заверение о правах"
                  sub={<>Я заверяю, что у меня есть достаточные права на загрузку этого файла: это моя рукопись, законно приобретённый экземпляр, произведение в общественном достоянии или иное законное основание. Ответственность за достоверность заверения я беру на себя.</>}/>
                <ConsentRow checked={consents.license} onChange={(v) => setConsents((c) => ({ ...c, license: v }))}
                  label={<>Принимаю <a className="lnk" onClick={(e) => { e.preventDefault(); go("legal", "upload"); }}>Условия загрузки произведения</a></>}
                  sub="Предоставляю ремарке ограниченную неисключительную лицензию на хранение, техническое воспроизведение, индексирование и анализ произведения — только для выдачи результата мне. Лицензия не даёт права публиковать или распространять файл."/>
                <ConsentRow checked={consents.process} onChange={(v) => setConsents((c) => ({ ...c, process: v }))}
                  label="Согласие на обработку и анализ"
                  sub="Содержимое файла обрабатывается автоматически: извлечение текста, построение векторного индекса, формирование разбора. Книга не публикуется, не используется для обучения моделей и не попадает в общий каталог — она видна только мне."/>
              </div>

              <div className="row" style={{ marginTop: 36 }}>
                <button className="btn btn-ghost" onClick={() => setStep(0)}>Назад</button>
                <button className="btn btn-mark" disabled={!consents.rights || !consents.license || !consents.process}
                  style={{ opacity: (consents.rights && consents.license && consents.process) ? 1 : 0.5 }}
                  onClick={() => { setStep(2); setProgress(0); }}>
                  Продолжить <Icon.Arrow/>
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="card" style={{ padding: 48, textAlign: "center" }}>
              <div style={{ fontFamily: "var(--f-serif)", fontSize: 52, color: "var(--mark)" }}>{progress}%</div>
              <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 8 }}>
                {progress < 30 && "Извлекаем текст из EPUB…"}
                {progress >= 30 && progress < 60 && "Разбиваем на фрагменты…"}
                {progress >= 60 && progress < 90 && "Индексируем для поиска…"}
                {progress >= 90 && "Собираем разбор…"}
              </div>
              <div style={{ height: 6, background: "var(--paper-2)", borderRadius: 100, marginTop: 32, overflow: "hidden" }}>
                <div style={{ width: `${progress}%`, height: "100%", background: "var(--mark)", transition: "width .15s" }}/>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="card" style={{ padding: 48, textAlign: "center" }}>
              <div style={{ width: 64, height: 64, borderRadius: "50%", background: "var(--mark-soft)", color: "var(--mark)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                <Icon.Check/>
              </div>
              <h3 style={{ fontSize: 28, marginTop: 20 }}>Книга в вашей библиотеке</h3>
              <p className="soft" style={{ fontSize: 15, marginTop: 12 }}>
                Разбор построен, чат готов отвечать. Приятного чтения.
              </p>
              <div className="row" style={{ justifyContent: "center", marginTop: 28 }}>
                <button className="btn btn-ghost" onClick={() => go("library")}><Icon.Library/> В библиотеку</button>
                <button className="btn btn-mark" onClick={() => go("library")}><Icon.Chat/> К книгам</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ConsentRow({ checked, onChange, label, sub }) {
  return (
    <label style={{ display: "grid", gridTemplateColumns: "28px 1fr", gap: 14, cursor: "pointer", padding: 20, borderRadius: "var(--r)", border: checked ? "1px solid var(--mark)" : "1px solid var(--rule)", background: checked ? "var(--mark-soft)" : "var(--cream)", transition: "all .15s" }}>
      <div style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${checked ? "var(--mark)" : "var(--ink-faint)"}`, background: checked ? "var(--mark)" : "transparent", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", marginTop: 2 }}>
        {checked && <Icon.Check2/>}
      </div>
      <div>
        <div style={{ fontFamily: "var(--f-serif)", fontSize: 16, color: "var(--ink)" }}>{label}</div>
        <div className="soft" style={{ fontSize: 13, lineHeight: 1.55, marginTop: 4 }}>{sub}</div>
      </div>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ display: "none" }}/>
    </label>
  );
}

// ===== Profile =====
function ScreenProfile({ go, onSignOut, tweaks, setTweak, plan = "free", onUpgrade, onDowngrade }) {
  const isPlus = plan === "plus";
  return (
    <div className="screen-fade">
      <div className="container-narrow" style={{ paddingTop: 56, paddingBottom: 96 }}>
        <div className="mono" style={{ color: "var(--mark)", marginBottom: 16 }}>Профиль</div>
        <div className="row" style={{ gap: 24, alignItems: "center" }}>
          <div className="avatar" style={{ width: 72, height: 72, fontSize: 28 }}>А</div>
          <div style={{ flex: 1 }}>
            <div className="row" style={{ gap: 12, alignItems: "baseline" }}>
              <h1 style={{ fontSize: 36, letterSpacing: "-0.02em" }}>Анна Соколова</h1>
              {isPlus && <div className="plan-pill plus"><Icon.Sparkle/> Плюс</div>}
            </div>
            <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 6 }}>anna.sokolova@gmail.com · Google</div>
          </div>
        </div>

        <div className="hr" style={{ margin: "40px 0" }}/>

        <Section title="Оформление">
          <Row label="Тема">
            <div className="row-sm">
              {["light", "dark"].map((t) => (
                <button key={t} className={`chip ${tweaks.theme === t ? "active" : ""}`} onClick={() => setTweak("theme", t)}>
                  {t === "light" ? "Светлая" : "Тёмная"}
                </button>
              ))}
            </div>
          </Row>
        </Section>

        <Section title="Приватность">
          <Row label="Cookie-файлы" sub="Необходимые cookie-файлы включены всегда. Аналитика — по согласию.">
            <button className="chip active" onClick={() => go("legal", "cookies")} style={{ cursor: "pointer" }}>Настройки</button>
          </Row>
          <Row label="Загруженные книги" sub="Видны только вам. Не попадают в каталог, не используются для обучения моделей.">
            <div className="chip" style={{ cursor: "default" }}>Только для вас</div>
          </Row>
          <Row label="Документы" sub="Пользовательское соглашение, политика ПДн, условия загрузки.">
            <div className="row-sm">
              <button className="chip" onClick={() => go("legal", "terms")}>Соглашение</button>
              <button className="chip" onClick={() => go("legal", "privacy")}>ПДн</button>
              <button className="chip" onClick={() => go("legal", "upload")}>Загрузка</button>
            </div>
          </Row>
        </Section>

        <Section title="Подписка">
          <div style={{ padding: 24 }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 260 }}>
                <div className="row" style={{ gap: 10, alignItems: "baseline" }}>
                  <div style={{ fontFamily: "var(--f-serif)", fontSize: 26, letterSpacing: "-0.01em" }}>
                    {isPlus ? "Плюс" : "Читатель"}
                  </div>
                  <div className="mono" style={{ color: "var(--ink-muted)" }}>
                    {isPlus ? "390 ₽ / мес · активен" : "бесплатный · бессрочно"}
                  </div>
                </div>
                <p className="soft" style={{ fontSize: 14, lineHeight: 1.55, marginTop: 10, maxWidth: 440 }}>
                  {isPlus
                    ? "Полный доступ к ремарке: каталог, чат, загрузка и анализ собственных книг. Следующее списание 14 марта."
                    : "Вы можете читать, задавать вопросы и добавлять книги из каталога. Загрузка собственных книг — на тарифе Плюс."}
                </p>
              </div>
              <div className="row-sm" style={{ alignItems: "center" }}>
                {isPlus ? (
                  <>
                    <button className="btn btn-ghost btn-sm" onClick={() => go("pricing")}>Сравнить</button>
                    <button className="btn btn-plain btn-sm" onClick={onDowngrade}>Отменить подписку</button>
                  </>
                ) : (
                  <>
                    <button className="btn btn-plain btn-sm" onClick={() => go("pricing")}>Сравнить тарифы</button>
                    <button className="btn btn-mark" onClick={onUpgrade}>
                      <Icon.Sparkle/> Перейти на Плюс
                    </button>
                  </>
                )}
              </div>
            </div>

            {!isPlus && (
              <div style={{
                marginTop: 20, padding: "14px 16px",
                background: "var(--paper-2)", border: "1px solid var(--rule)", borderRadius: "var(--r)",
                display: "flex", gap: 12, alignItems: "flex-start"
              }}>
                <div style={{ color: "var(--mark)", marginTop: 2 }}><Icon.Sparkle/></div>
                <div>
                  <div style={{ fontSize: 14, color: "var(--ink)" }}>Что откроет Плюс</div>
                  <div className="soft" style={{ fontSize: 13, lineHeight: 1.55, marginTop: 4 }}>
                    Загрузку книг в EPUB, FB2, PDF · персональный AI-разбор каждой · чат с любой из ваших книг.
                  </div>
                </div>
              </div>
            )}
          </div>
        </Section>

        <Section title="Аккаунт">
          <div className="row" style={{ padding: "20px 20px", gap: 12 }}>
            <button className="btn btn-ghost">Выгрузить данные</button>
            <button className="btn btn-plain" onClick={onSignOut}>Выйти</button>
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginTop: 40 }}>
      <h3 style={{ fontSize: 22, marginBottom: 18 }}>{title}</h3>
      <div className="card" style={{ padding: 4 }}>{children}</div>
    </div>
  );
}

function Row({ label, sub, children }) {
  return (
    <div style={{ padding: "18px 20px", borderBottom: "1px solid var(--rule-soft)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 20 }}>
      <div>
        <div style={{ fontSize: 15, color: "var(--ink)" }}>{label}</div>
        {sub && <div className="soft" style={{ fontSize: 13, marginTop: 4, maxWidth: 420 }}>{sub}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

Object.assign(window, { ScreenLibrary, ScreenUpload, ScreenProfile });
