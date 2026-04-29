// remarka — единый чат с сессиями

const { useState: useSC, useEffect: useEC, useRef: useRC, useMemo: useMC } = React;

// Сессии чата — источник правды в App, сюда приходят через пропсы
// session: { id, title, scope: 'book'|'library'|'selection', bookId?, bookIds?: string[], messages: [], createdAt }

function ScreenChat({ go, owned, sessions, activeId, onActive, onCreate, onDelete, onRename, onAppend, onBook }) {
  const session = sessions.find((s) => s.id === activeId) || sessions[0];
  const [draft, setDraft] = useSC("");
  const [typing, setTyping] = useSC(false);
  const [activeCite, setActiveCite] = useSC(null);
  const [search, setSearch] = useSC("");
  const [renaming, setRenaming] = useSC(null);
  const scrollRef = useRC(null);

  const myBooks = window.REMARKA.BOOKS.filter((b) => owned.has(b.id));

  useEC(() => { scrollRef.current?.scrollTo({ top: 999999, behavior: "smooth" }); }, [session?.messages?.length, typing]);
  useEC(() => { setActiveCite(null); setDraft(""); }, [activeId]);

  const filteredSessions = useMC(() => {
    if (!search) return sessions;
    const s = search.toLowerCase();
    return sessions.filter((x) => x.title.toLowerCase().includes(s));
  }, [sessions, search]);

  if (!session) {
    return <div style={{ padding: 48, textAlign: "center" }}>Нет активной сессии</div>;
  }

  const scopeBook = session.scope === "book" ? window.REMARKA.BOOKS.find((b) => b.id === session.bookId) : null;
  const scopeSelection = session.scope === "selection"
    ? (session.bookIds || []).map((id) => window.REMARKA.BOOKS.find((b) => b.id === id)).filter(Boolean)
    : null;

  const send = (text) => {
    const t = (text ?? draft).trim();
    if (!t) return;
    onAppend(session.id, { r: "user", t });
    setDraft("");
    setTyping(true);
    setTimeout(() => {
      setTyping(false);
      // Генерируем ответ в зависимости от scope
      if (session.scope === "book") {
        onAppend(session.id, {
          r: "ai",
          t: "Воланд не случайно выбирает Москву 1930-х: это общество, которое отменило и религию, и само понятие зла как метафизической категории. Его появление — проверка: если ни Бога, ни дьявола нет, откуда тогда всё происходящее? Булгаков переворачивает атеистический тезис, заставляя героев столкнуться с реальностью того, в существование чего они отказались верить.",
          cites: [
            { ch: "Глава 1", p: 12, q: "— Вы — атеисты?! — ...ответил Берлиоз, вежливо улыбнувшись." },
            { ch: "Глава 3", p: 37, q: "Имейте в виду, что Иисус существовал." },
          ],
        });
      } else if (session.scope === "selection") {
        const ids = session.bookIds || [];
        const picks = ids.slice(0, 3).map((id) => ({
          bookId: id,
          cites: [{ ch: "Часть 1, гл. 3", p: 42 + (id.length * 7) % 200 }],
        }));
        onAppend(session.id, {
          r: "ai",
          t: `В выбранных книгах (${picks.length}) тема звучит по-разному. Общий мотив — разлад между внутренним опытом и внешней ролью: герои знают больше, чем могут позволить себе сказать. Разница — в том, чем они за это платят.`,
          multi: picks,
        });
      } else {
        onAppend(session.id, {
          r: "ai",
          t: "В ваших книгах тема одиночества звучит очень по-разному. У Толстого это одиночество в толпе — Анна среди гостей и мужа, который её не видит. У Достоевского — добровольная изоляция идеи: Раскольников отгораживается от матери и сестры, чтобы «додумать» теорию до конца.",
          multi: [
            { bookId: "anna", cites: [{ ch: "Часть 1, гл. 30", p: 98 }] },
            { bookId: "crime", cites: [{ ch: "Часть 3, гл. 5", p: 236 }] },
          ],
        });
      }
    }, 1300);
  };

  const groupedSessions = useMC(() => {
    const groups = { today: [], week: [], earlier: [] };
    const now = Date.now();
    const day = 86400000;
    filteredSessions.forEach((s) => {
      const age = now - s.createdAt;
      if (age < day) groups.today.push(s);
      else if (age < 7 * day) groups.week.push(s);
      else groups.earlier.push(s);
    });
    return groups;
  }, [filteredSessions]);

  const suggested = session.scope === "book"
    ? window.REMARKA.SUGGESTED_PROMPTS_BOOK
    : window.REMARKA.SUGGESTED_PROMPTS_LIB;

  return (
    <div className="screen-fade" style={{ display: "grid", gridTemplateColumns: "288px 1fr 340px", height: "calc(100vh - 64px)", borderTop: "1px solid var(--rule)" }}>
      {/* Левая панель — сессии */}
      <div style={{ borderRight: "1px solid var(--rule)", background: "var(--paper-2)", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ padding: "18px 18px 12px" }}>
          <button className="btn btn-mark btn-block" onClick={onCreate}>
            <Icon.Plus/> Новый чат
          </button>
        </div>
        <div style={{ padding: "0 18px 12px" }}>
          <div style={{ position: "relative" }}>
            <Icon.Search style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--ink-faint)" }}/>
            <input className="input" placeholder="Поиск по чатам" value={search} onChange={(e) => setSearch(e.target.value)}
              style={{ paddingLeft: 36, height: 36, fontSize: 13 }}/>
          </div>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "4px 8px 18px" }}>
          {Object.entries({ today: "Сегодня", week: "На неделе", earlier: "Раньше" }).map(([k, label]) => {
            const list = groupedSessions[k];
            if (!list.length) return null;
            return (
              <div key={k} style={{ marginBottom: 18 }}>
                <div className="mono" style={{ color: "var(--ink-faint)", padding: "8px 12px 6px" }}>{label}</div>
                <div>
                  {list.map((s) => (
                    <SessionItem key={s.id} s={s} active={s.id === activeId}
                      renaming={renaming === s.id}
                      onClick={() => onActive(s.id)}
                      onStartRename={() => setRenaming(s.id)}
                      onRename={(title) => { onRename(s.id, title); setRenaming(null); }}
                      onCancelRename={() => setRenaming(null)}
                      onDelete={() => onDelete(s.id)}/>
                  ))}
                </div>
              </div>
            );
          })}
          {filteredSessions.length === 0 && (
            <div className="soft" style={{ fontSize: 13, padding: "24px 12px", textAlign: "center" }}>
              Чатов не найдено
            </div>
          )}
        </div>
        <ChatSidebarLegal go={go}/>
      </div>

      {/* Центр — диалог */}
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ padding: "14px 32px", borderBottom: "1px solid var(--rule)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
          <div className="row-sm" style={{ minWidth: 0 }}>
            {scopeBook ? (
              <>
                <div style={{ width: 28, flexShrink: 0 }}><BookCover book={scopeBook} size="sm"/></div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: "var(--f-serif)", fontSize: 15, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.title}</div>
                  <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 2 }}>По книге · {scopeBook.author}</div>
                </div>
              </>
            ) : scopeSelection ? (
              <>
                <div style={{ position: "relative", width: 40, height: 28, flexShrink: 0 }}>
                  {scopeSelection.slice(0, 3).map((b, i) => (
                    <div key={b.id} style={{ position: "absolute", left: i * 7, top: 0, width: 20, zIndex: 3 - i }}>
                      <BookCover book={b} size="sm"/>
                    </div>
                  ))}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: "var(--f-serif)", fontSize: 15, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.title}</div>
                  <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 2 }}>Подборка · {scopeSelection.length} {decl(scopeSelection.length, ["книга", "книги", "книг"])}</div>
                </div>
              </>
            ) : (
              <>
                <div style={{ width: 28, height: 28, borderRadius: 6, background: "var(--mark-soft)", color: "var(--mark)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Icon.Library/>
                </div>
                <div>
                  <div style={{ fontFamily: "var(--f-serif)", fontSize: 15, lineHeight: 1.2 }}>{session.title}</div>
                  <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 2 }}>По всей библиотеке · {myBooks.length} {decl(myBooks.length, ["книга", "книги", "книг"])}</div>
                </div>
              </>
            )}
          </div>
          <div className="row-sm">
            <ScopePicker session={session} myBooks={myBooks} onChangeScope={(scope, arg) => {
              // Переключаем scope текущего пустого чата, либо создаём новый
              const titleFor = (sc, a) => {
                if (sc === "book") return window.REMARKA.BOOKS.find(b => b.id === a)?.title || "Новый чат";
                if (sc === "selection") return `Подборка · ${(a || []).length} ${decl((a || []).length, ["книга","книги","книг"])}`;
                return "Новый чат по библиотеке";
              };
              if (session.messages.length === 0) {
                onRename(session.id, titleFor(scope, arg));
                window.__remarkaUpdateScope?.(session.id, scope, arg);
              } else {
                onCreate(scope, arg);
              }
            }}/>
            <button className="btn btn-plain btn-sm" title="Сохранить"><Icon.Bookmark/></button>
          </div>
        </div>

        <div ref={scrollRef} style={{ flex: 1, overflow: "auto", padding: "32px 48px" }}>
          <div style={{ maxWidth: 760, margin: "0 auto" }} className="stack-xl">
            {session.messages.length === 0 ? (
              <ChatWelcome session={session} scopeBook={scopeBook} scopeSelection={scopeSelection} myBooks={myBooks}/>
            ) : (
              session.messages.map((m, i) => (
                m.r === "user" ? (
                  <div key={i} style={{ textAlign: "right" }}>
                    <div className="mono" style={{ color: "var(--ink-faint)", marginBottom: 6 }}>Вы</div>
                    <div style={{ display: "inline-block", maxWidth: "85%", padding: "14px 18px", background: "var(--ink)", color: "var(--paper)", borderRadius: "var(--r-lg)", borderTopRightRadius: 4, fontSize: 15, textAlign: "left", lineHeight: 1.5 }}>{m.t}</div>
                  </div>
                ) : (
                  m.multi ? <LibMsg key={i} m={m} onBook={onBook}/> : <MsgBubble key={i} m={m} onCite={setActiveCite}/>
                )
              ))
            )}
            {typing && <Typing/>}
          </div>
        </div>

        <div style={{ padding: "20px 48px 28px" }}>
          <div style={{ maxWidth: 760, margin: "0 auto" }}>
            {session.messages.length < 2 && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                {suggested.map((p) => (
                  <button key={p} className="sug" onClick={() => send(p)}>
                    <span className="k">вопрос</span>{p}
                  </button>
                ))}
              </div>
            )}
            <div style={{ background: "var(--cream)", border: "1px solid var(--rule)", borderRadius: "var(--r-lg)", padding: "14px 18px", boxShadow: "var(--shadow-sm)" }}>
              <textarea className="textarea" rows={2} value={draft} onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder={
                  session.scope === "book" ? `Спросите о «${scopeBook?.title}»…` :
                  session.scope === "selection" ? `Спросите по подборке (${scopeSelection?.length || 0} книг)…` :
                  "Спросите что-нибудь по вашей библиотеке…"
                }
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

      {/* Правая панель — контекст */}
      <div style={{ borderLeft: "1px solid var(--rule)", background: "var(--paper-2)", overflow: "auto" }}>
        {activeCite ? (
          <div style={{ padding: 28 }}>
            <div className="mono" style={{ color: "var(--mark)", marginBottom: 10 }}>Источник</div>
            <div style={{ fontFamily: "var(--f-serif)", fontSize: 18 }}>{activeCite.ch}</div>
            <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 4 }}>Страница {activeCite.p}</div>
            <div style={{ marginTop: 20, padding: 18, background: "var(--cream)", border: "1px solid var(--rule)", borderRadius: "var(--r)", fontFamily: "var(--f-serif)", fontSize: 15, lineHeight: 1.65 }}>
              <span style={{ color: "var(--mark)", fontSize: 28, lineHeight: 0, position: "relative", top: 10, marginRight: 4 }}>«</span>
              {activeCite.q}
              <span style={{ color: "var(--mark)", fontSize: 28, lineHeight: 0, position: "relative", top: 10, marginLeft: 2 }}>»</span>
            </div>
            <button className="btn btn-ghost btn-sm btn-block" style={{ marginTop: 16 }}>
              <Icon.Book/> Открыть в книге
            </button>
            <button className="btn btn-plain btn-sm btn-block" style={{ marginTop: 8 }} onClick={() => setActiveCite(null)}>
              Скрыть
            </button>
          </div>
        ) : (
          <ContextPanel session={session} scopeBook={scopeBook} scopeSelection={scopeSelection} myBooks={myBooks} onBook={onBook} go={go}/>
        )}
      </div>
    </div>
  );
}

function SessionItem({ s, active, renaming, onClick, onStartRename, onRename, onCancelRename, onDelete }) {
  const [val, setVal] = useSC(s.title);
  const inputRef = useRC(null);
  useEC(() => { if (renaming) { setVal(s.title); inputRef.current?.focus(); inputRef.current?.select(); } }, [renaming]);

  const book = s.scope === "book" ? window.REMARKA.BOOKS.find((b) => b.id === s.bookId) : null;
  const selBooks = s.scope === "selection" ? (s.bookIds || []).map((id) => window.REMARKA.BOOKS.find((b) => b.id === id)).filter(Boolean) : null;
  const subtitle = s.scope === "book" ? (book?.author || "Книга")
    : s.scope === "selection" ? `Подборка · ${selBooks?.length || 0} ${decl(selBooks?.length || 0, ["книга", "книги", "книг"])}`
    : "Вся библиотека";

  return (
    <div className={`session-item ${active ? "active" : ""}`} onClick={onClick}>
      <div className="si-icon">
        {book ? <BookCover book={book} size="sm"/> :
          selBooks ? (
            <div style={{ position: "relative", width: 32, height: "100%", minHeight: 40 }}>
              {selBooks.slice(0, 3).map((b, i) => (
                <div key={b.id} style={{ position: "absolute", left: i * 4, top: i * 2, width: 22, zIndex: 3 - i, boxShadow: "0 1px 3px rgba(0,0,0,.15)" }}>
                  <BookCover book={b} size="sm"/>
                </div>
              ))}
            </div>
          ) :
          <div style={{ width: "100%", aspectRatio: "2/3", background: "var(--ink)", color: "var(--paper)", borderRadius: 3, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon.Library/>
          </div>}
      </div>
      <div className="si-main">
        {renaming ? (
          <input ref={inputRef} className="input" value={val}
            onChange={(e) => setVal(e.target.value)}
            onBlur={() => onRename(val.trim() || s.title)}
            onKeyDown={(e) => { if (e.key === "Enter") onRename(val.trim() || s.title); if (e.key === "Escape") onCancelRename(); }}
            style={{ height: 24, fontSize: 13, padding: "4px 6px" }}
            onClick={(e) => e.stopPropagation()}/>
        ) : (
          <div className="si-title">{s.title}</div>
        )}
        <div className="si-sub">
          {subtitle} · {s.messages.length} {decl(s.messages.length, ["сообщ.", "сообщ.", "сообщ."])}
        </div>
      </div>
      {!renaming && (
        <div className="si-actions">
          <button onClick={(e) => { e.stopPropagation(); onStartRename(); }} title="Переименовать">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          </button>
          <button onClick={(e) => { e.stopPropagation(); if (confirm("Удалить чат?")) onDelete(); }} title="Удалить">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        </div>
      )}
      <style>{`
        .session-item { display: grid; grid-template-columns: 32px 1fr auto; gap: 10px; align-items: center; padding: 10px 12px; border-radius: var(--r); cursor: pointer; transition: background .15s; position: relative; }
        .session-item:hover { background: var(--cream); }
        .session-item.active { background: var(--cream); box-shadow: inset 0 0 0 1px var(--rule); }
        .si-icon { width: 32px; }
        .si-main { min-width: 0; }
        .si-title { font-size: 13px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
        .si-sub { font-size: 11px; color: var(--ink-muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .si-actions { display: flex; gap: 2px; opacity: 0; transition: opacity .15s; }
        .session-item:hover .si-actions, .session-item.active .si-actions { opacity: 1; }
        .si-actions button { width: 24px; height: 24px; border-radius: 4px; color: var(--ink-muted); display: flex; align-items: center; justify-content: center; }
        .si-actions button:hover { background: var(--paper-2); color: var(--ink); }
      `}</style>
    </div>
  );
}

function ScopePicker({ session, myBooks, onChangeScope }) {
  const [open, setOpen] = useSC(false);
  const [mode, setMode] = useSC("root"); // root | selection
  const initialSel = session.scope === "selection" ? new Set(session.bookIds || []) : new Set();
  const [sel, setSel] = useSC(initialSel);
  const wrapRef = useRC(null);
  useEC(() => {
    const h = (e) => { if (open && wrapRef.current && !wrapRef.current.contains(e.target)) { setOpen(false); setMode("root"); } };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  useEC(() => {
    if (open) setSel(session.scope === "selection" ? new Set(session.bookIds || []) : new Set());
  }, [open]);

  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div style={{ position: "relative" }} ref={wrapRef}>
      <button className="btn btn-ghost btn-sm" onClick={() => { setOpen((v) => !v); setMode("root"); }}>
        <Icon.Filter/> Область
      </button>
      {open && mode === "root" && (
        <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", width: 280, background: "var(--cream)", border: "1px solid var(--rule)", borderRadius: "var(--r-lg)", boxShadow: "var(--shadow-lg)", zIndex: 50, padding: 8 }}>
          <div className="mono" style={{ color: "var(--ink-faint)", padding: "6px 10px" }}>Переключить контекст</div>
          <button className="scope-item" onClick={() => { onChangeScope("library"); setOpen(false); }}>
            <Icon.Library/>
            <div style={{ minWidth: 0 }}>
              <div>Вся библиотека</div>
              <div className="si-hint">{myBooks.length} {decl(myBooks.length, ["книга", "книги", "книг"])}</div>
            </div>
          </button>
          <button className="scope-item" onClick={() => setMode("selection")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h12v10H4z"/><path d="M8 4h12v10"/></svg>
            <div style={{ minWidth: 0 }}>
              <div>Подборка книг…</div>
              <div className="si-hint">Выберите несколько</div>
            </div>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: "auto", color: "var(--ink-faint)" }}><path d="m9 18 6-6-6-6"/></svg>
          </button>
          <div className="hr" style={{ margin: "6px 0" }}/>
          <div className="mono" style={{ color: "var(--ink-faint)", padding: "6px 10px" }}>Одна книга</div>
          <div style={{ maxHeight: 220, overflow: "auto" }}>
            {myBooks.map((b) => (
              <button key={b.id} className="scope-item" onClick={() => { onChangeScope("book", b.id); setOpen(false); }}>
                <div style={{ width: 20, flexShrink: 0 }}><BookCover book={b} size="sm"/></div>
                <div style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.title}</div>
              </button>
            ))}
          </div>
          <style>{`.scope-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; border-radius: var(--r-sm); font-size: 13px; color: var(--ink); text-align: left; cursor: pointer; } .scope-item:hover { background: var(--paper-2); } .si-hint { font-size: 11px; color: var(--ink-muted); margin-top: 1px; }`}</style>
        </div>
      )}
      {open && mode === "selection" && (
        <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", width: 320, background: "var(--cream)", border: "1px solid var(--rule)", borderRadius: "var(--r-lg)", boxShadow: "var(--shadow-lg)", zIndex: 50, overflow: "hidden", display: "flex", flexDirection: "column", maxHeight: 420 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--rule)" }}>
            <button onClick={() => setMode("root")} style={{ display: "flex", alignItems: "center", color: "var(--ink-muted)", padding: 4 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
            </button>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Подборка книг</div>
            <div className="mono" style={{ color: "var(--ink-muted)", marginLeft: "auto", fontSize: 10 }}>выбрано {sel.size}</div>
          </div>
          <div style={{ overflow: "auto", padding: 6, flex: 1 }}>
            {myBooks.map((b) => {
              const checked = sel.has(b.id);
              return (
                <label key={b.id} className="scope-item" style={{ cursor: "pointer", padding: "8px 10px" }}>
                  <div style={{ width: 16, height: 16, borderRadius: 3, border: "1.5px solid " + (checked ? "var(--mark)" : "var(--rule-strong)"), background: checked ? "var(--mark)" : "transparent", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    {checked && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>}
                  </div>
                  <input type="checkbox" checked={checked} onChange={() => toggle(b.id)} style={{ position: "absolute", opacity: 0, pointerEvents: "none" }}/>
                  <div style={{ width: 22, flexShrink: 0 }}><BookCover book={b} size="sm"/></div>
                  <div style={{ minWidth: 0, overflow: "hidden" }} onClick={() => toggle(b.id)}>
                    <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.title}</div>
                    <div style={{ fontSize: 11, color: "var(--ink-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.author}</div>
                  </div>
                </label>
              );
            })}
          </div>
          <div style={{ padding: 10, borderTop: "1px solid var(--rule)", display: "flex", gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setSel(new Set(myBooks.map(b => b.id)))} style={{ flex: 1 }}>Все</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setSel(new Set())} style={{ flex: 1 }}>Сбросить</button>
            <button className="btn btn-mark btn-sm" disabled={sel.size < 2} onClick={() => { onChangeScope("selection", [...sel]); setOpen(false); setMode("root"); }} style={{ flex: 1.5 }}>Применить</button>
          </div>
          <style>{`.scope-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; border-radius: var(--r-sm); font-size: 13px; color: var(--ink); text-align: left; cursor: pointer; position: relative; } .scope-item:hover { background: var(--paper-2); }`}</style>
        </div>
      )}
    </div>
  );
}

function ChatWelcome({ session, scopeBook, scopeSelection, myBooks }) {
  if (scopeBook) {
    return (
      <div style={{ textAlign: "center", paddingTop: 40 }}>
        <div style={{ width: 120, margin: "0 auto" }}><BookCover book={scopeBook} size="md"/></div>
        <h2 style={{ fontSize: 28, marginTop: 24, letterSpacing: "-0.015em" }}>{scopeBook.title}</h2>
        <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 6 }}>{scopeBook.author} · {scopeBook.pages} стр.</div>
        <p className="soft" style={{ fontSize: 15, marginTop: 20, maxWidth: 460, margin: "20px auto 0", lineHeight: 1.6 }}>
          Спросите о сюжете, героях, мотивах или стиле. Ремарка ответит с цитатой и точной страницей.
        </p>
      </div>
    );
  }
  if (scopeSelection) {
    return (
      <div style={{ textAlign: "center", paddingTop: 40 }}>
        <div style={{ display: "inline-flex" }}>
          {scopeSelection.slice(0, 4).map((b, i) => (
            <div key={b.id} style={{ width: 84, marginLeft: i ? -22 : 0, transform: `rotate(${(i - (scopeSelection.length - 1) / 2) * 5}deg)`, zIndex: 10 - i }}>
              <BookCover book={b} size="sm"/>
            </div>
          ))}
        </div>
        <h2 style={{ fontSize: 28, marginTop: 28, letterSpacing: "-0.015em" }}>Разговор по подборке</h2>
        <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 6 }}>{scopeSelection.length} {decl(scopeSelection.length, ["книга", "книги", "книг"])}</div>
        <p className="soft" style={{ fontSize: 15, marginTop: 20, maxWidth: 480, margin: "20px auto 0", lineHeight: 1.6 }}>
          Сравните героев, мотивы и стиль избранных книг. Ответы будут со ссылками на каждую из них.
        </p>
      </div>
    );
  }
  return (
    <div style={{ textAlign: "center", paddingTop: 40 }}>
      <div style={{ display: "inline-flex", gap: -10 }}>
        {myBooks.slice(0, 4).map((b, i) => (
          <div key={b.id} style={{ width: 72, marginLeft: i ? -18 : 0, transform: `rotate(${(i - 1.5) * 4}deg)`, zIndex: 10 - i }}>
            <BookCover book={b} size="sm"/>
          </div>
        ))}
      </div>
      <h2 style={{ fontSize: 28, marginTop: 24, letterSpacing: "-0.015em" }}>Разговор по всей полке</h2>
      <p className="soft" style={{ fontSize: 15, marginTop: 14, maxWidth: 460, margin: "14px auto 0", lineHeight: 1.6 }}>
        Задайте вопрос — AI сам найдёт, в каких книгах искать, и укажет источники.
      </p>
    </div>
  );
}

function ContextPanel({ session, scopeBook, scopeSelection, myBooks, onBook, go }) {
  if (scopeBook) {
    return (
      <div style={{ padding: 28 }}>
        <div className="mono" style={{ color: "var(--mark)", marginBottom: 14 }}>Контекст разговора</div>
        <div style={{ width: 140, margin: "0 auto" }}><BookCover book={scopeBook} size="md"/></div>
        <div style={{ textAlign: "center", marginTop: 16 }}>
          <div style={{ fontFamily: "var(--f-serif)", fontSize: 17, lineHeight: 1.25 }}>{scopeBook.title}</div>
          <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 6 }}>{scopeBook.author}</div>
        </div>
        <div className="hr" style={{ margin: "20px 0" }}/>
        <button className="btn btn-ghost btn-sm btn-block" onClick={() => go("book", scopeBook.id)}>
          <Icon.Book/> Открыть разбор
        </button>
        <div className="mono" style={{ color: "var(--ink-faint)", marginTop: 24, marginBottom: 10 }}>Подсказка</div>
        <p className="soft" style={{ fontSize: 13, lineHeight: 1.55 }}>
          Нажмите на цитату под ответом — здесь откроется точное место в книге.
        </p>
      </div>
    );
  }
  const contextBooks = scopeSelection || myBooks;
  const isSelection = !!scopeSelection;
  return (
    <div style={{ padding: 24 }}>
      <div className="mono" style={{ color: "var(--mark)", marginBottom: 14 }}>
        {isSelection ? "Подборка" : "В разговоре"} · {contextBooks.length} {decl(contextBooks.length, ["книга", "книги", "книг"])}
      </div>
      <div className="stack-sm">
        {contextBooks.map((b) => (
          <div key={b.id} className="row" style={{ padding: 10, borderRadius: "var(--r)", background: "var(--cream)", border: "1px solid var(--rule)", cursor: "pointer" }} onClick={() => onBook(b.id)}>
            <div style={{ width: 34, flexShrink: 0 }}><BookCover book={b} size="sm"/></div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: "var(--f-serif)", fontSize: 13, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.title}</div>
              <div style={{ fontSize: 10, color: "var(--ink-muted)", marginTop: 2 }}>{b.author}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="hr" style={{ margin: "20px 0" }}/>
      {isSelection ? (
        <p className="soft" style={{ fontSize: 13, lineHeight: 1.55 }}>
          Ремарка будет искать ответы только в этих книгах — удобно для сравнительного анализа.
        </p>
      ) : (
        <button className="btn btn-ghost btn-sm btn-block" onClick={() => go("upload")}>
          <Icon.Plus/> Добавить книгу
        </button>
      )}
    </div>
  );
}

function MsgBubble({ m, onCite }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "36px 1fr", gap: 16 }}>
      <div style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--mark-soft)", color: "var(--mark)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Icon.Sparkle/>
      </div>
      <div>
        <div className="mono" style={{ color: "var(--mark)", marginBottom: 8 }}>Ремарка</div>
        <div style={{ fontFamily: "var(--f-serif)", fontSize: 17, lineHeight: 1.6, color: "var(--ink)", textWrap: "pretty" }}>{m.t}</div>
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

function decl(n, forms) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

Object.assign(window, { ScreenChat });
