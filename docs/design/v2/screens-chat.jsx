// remarka — единый чат с сессиями (только по одной книге)

const { useState: useSC, useEffect: useEC, useRef: useRC, useMemo: useMC } = React;

// session: { id, title, scope: 'book', bookId, messages: [], createdAt }

function ScreenChat({ go, owned, sessions, activeId, onActive, onCreate, onDelete, onRename, onAppend, onBook, openReader }) {
  const session = sessions.find((s) => s.id === activeId) || sessions[0];
  const [draft, setDraft] = useSC("");
  const [typing, setTyping] = useSC(false);
  const [search, setSearch] = useSC("");
  const [renaming, setRenaming] = useSC(null);
  const [sessionsOpen, setSessionsOpen] = useSC(false);
  // Фокус правой панели: 'info' | 'cites'
  const [panelFocus, setPanelFocus] = useSC("info");
  // Подсветка одной цитаты в панели после клика на бейдж в чате
  const [flashCite, setFlashCite] = useSC(null); // { msgIdx, citeIdx }
  const scrollRef = useRC(null);

  const myBooks = window.REMARKA.BOOKS.filter((b) => owned.has(b.id));

  useEC(() => { scrollRef.current?.scrollTo({ top: 999999, behavior: "smooth" }); }, [session?.messages?.length, typing]);
  useEC(() => { setDraft(""); setSessionsOpen(false); setPanelFocus("info"); setFlashCite(null); }, [activeId]);

  // Цитаты текущей книги, сгруппированные ПО ВОПРОСУ
  const citesByQuestion = useMC(() => {
    const messages = session?.messages || [];
    const questionFor = (idx) => {
      for (let k = idx - 1; k >= 0; k--) if (messages[k]?.r === "user") return { t: messages[k].t, msgIdx: k };
      return { t: "Без вопроса", msgIdx: null };
    };
    const groups = new Map();
    messages.forEach((m, i) => {
      if (m.r !== "ai" || !m.cites?.length) return;
      const q = questionFor(i);
      const key = q.msgIdx ?? -1;
      if (!groups.has(key)) groups.set(key, { q: q.t, qMsgIdx: q.msgIdx, msgIdx: i, items: [] });
      m.cites.forEach((c, ci) => groups.get(key).items.push({ c, msgIdx: i, citeIdx: ci }));
    });
    return Array.from(groups.values()).sort((a, b) => a.msgIdx - b.msgIdx);
  }, [session]);
  const totalCites = citesByQuestion.reduce((n, g) => n + g.items.length, 0);

  // Скролл к сообщению в чате
  const scrollToMsg = (msgIdx) => {
    const el = scrollRef.current?.querySelector(`[data-msg-idx="${msgIdx}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("msg-flash");
    setTimeout(() => el.classList.remove("msg-flash"), 1400);
  };

  // Клик на бейдж цитаты под ответом — переключаем фокус на цитаты + флэш
  const focusCiteInPanel = (msgIdx, citeIdx) => {
    setPanelFocus("cites");
    setFlashCite({ msgIdx, citeIdx });
    setTimeout(() => setFlashCite(null), 1600);
  };

  const filteredSessions = useMC(() => {
    if (!search) return sessions;
    const s = search.toLowerCase();
    return sessions.filter((x) => x.title.toLowerCase().includes(s));
  }, [sessions, search]);

  if (!session) {
    return <div style={{ padding: 48, textAlign: "center" }}>Нет активной сессии</div>;
  }

  const scopeBook = window.REMARKA.BOOKS.find((b) => b.id === session.bookId);

  const send = (text) => {
    const t = (text ?? draft).trim();
    if (!t) return;
    onAppend(session.id, { r: "user", t });
    setDraft("");
    setTyping(true);
    setTimeout(() => {
      setTyping(false);
      onAppend(session.id, {
        r: "ai",
        t: "Воланд не случайно выбирает Москву 1930-х: это общество, которое отменило и религию, и само понятие зла как метафизической категории. Его появление — проверка: если ни Бога, ни дьявола нет, откуда тогда всё происходящее? Булгаков переворачивает атеистический тезис, заставляя героев столкнуться с реальностью того, в существование чего они отказались верить.",
        cites: [
          { ch: "Глава 1", p: 12, q: "— Вы — атеисты?! — ...ответил Берлиоз, вежливо улыбнувшись." },
          { ch: "Глава 3", p: 37, q: "Имейте в виду, что Иисус существовал." },
        ],
      });
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

  const suggested = window.REMARKA.SUGGESTED_PROMPTS_BOOK;

  return (
    <div className="screen-fade chat-shell" style={{ display: "grid", gridTemplateColumns: "288px 1fr 340px", height: "calc(100vh - 64px)", borderTop: "1px solid var(--rule)" }}>
      {/* Левая панель — сессии */}
      {sessionsOpen && <div className="chat-sessions-backdrop" onClick={() => setSessionsOpen(false)}/>}
      <div className={`chat-sessions ${sessionsOpen ? "open" : ""}`} style={{ borderRight: "1px solid var(--rule)", background: "var(--paper-2)", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <button className="chat-sessions-close" onClick={() => setSessionsOpen(false)} aria-label="Закрыть">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
        <div style={{ padding: "18px 18px 12px" }}>
          <BookPicker myBooks={myBooks} onPick={(id) => onCreate(id)} go={go}/>
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
        <div className="chat-header" style={{ padding: "14px 32px", borderBottom: "1px solid var(--rule)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
          <div className="row-sm" style={{ minWidth: 0 }}>
            <button className="chat-mobile-sessions-btn" onClick={() => setSessionsOpen(true)} aria-label="Сессии">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="18" y2="18"/></svg>
              Чаты
            </button>
            {scopeBook ? (
              <>
                <div style={{ width: 28, flexShrink: 0 }}><BookCover book={scopeBook} size="sm"/></div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: "var(--f-serif)", fontSize: 15, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.title}</div>
                  <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 2 }}>{scopeBook.author}</div>
                </div>
              </>
            ) : (
              <div className="mono" style={{ color: "var(--ink-muted)" }}>Книга не выбрана</div>
            )}
          </div>
          <div className="row-sm">
            <button
              className={`btn btn-plain btn-sm ${panelFocus === "cites" ? "is-active" : ""}`}
              title="Цитаты из разговора"
              aria-label="Цитаты из разговора"
              disabled={totalCites === 0}
              style={{ opacity: totalCites === 0 ? 0.5 : 1 }}
              onClick={() => {
                if (totalCites === 0) return;
                setPanelFocus(panelFocus === "cites" ? "info" : "cites");
              }}>
              <Icon.Quote/>
              {totalCites > 0 && <span style={{ marginLeft: 6, fontSize: 11, color: "var(--ink-muted)" }}>{totalCites}</span>}
            </button>
          </div>
        </div>

        <div ref={scrollRef} className="chat-messages" style={{ flex: 1, overflow: "auto", padding: "32px 48px" }}>
          <div style={{ maxWidth: 760, margin: "0 auto" }} className="stack-xl">
            {session.messages.length === 0 ? (
              <ChatWelcome scopeBook={scopeBook}/>
            ) : (
              session.messages.map((m, i) => (
                m.r === "user" ? (
                  <div key={i} data-msg-idx={i} className="msg-row" style={{ textAlign: "right" }}>
                    <div className="mono" style={{ color: "var(--ink-faint)", marginBottom: 6 }}>Вы</div>
                    <div style={{ display: "inline-block", maxWidth: "85%", padding: "14px 18px", background: "var(--ink)", color: "var(--paper)", borderRadius: "var(--r-lg)", borderTopRightRadius: 4, fontSize: 15, textAlign: "left", lineHeight: 1.5 }}>{m.t}</div>
                  </div>
                ) : (
                  <div key={i} data-msg-idx={i} className="msg-row">
                    <MsgBubble m={m} onCite={(c, ci) => focusCiteInPanel(i, ci)}/>
                  </div>
                )
              ))
            )}
            {typing && <Typing/>}
          </div>
        </div>

        <div className="chat-composer-wrap" style={{ padding: "20px 48px 28px" }}>
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
                placeholder={scopeBook ? `Спросите о «${scopeBook.title}»…` : "Спросите о книге…"}
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

      {/* Правая панель — контекст книги */}
      <div className="chat-context" style={{ borderLeft: "1px solid var(--rule)", background: "var(--paper-2)", overflow: "auto" }}>
        <ContextPanel
          book={scopeBook}
          citesByQuestion={citesByQuestion}
          totalCites={totalCites}
          focus={panelFocus}
          setFocus={setPanelFocus}
          flashCite={flashCite}
          onScrollToMsg={scrollToMsg}
          openReader={openReader}
          onBook={onBook}
        />
      </div>
    </div>
  );
}

function BookPicker({ myBooks, onPick, go }) {
  const [open, setOpen] = useSC(false);
  const wrapRef = useRC(null);
  useEC(() => {
    const h = (e) => { if (open && wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  if (myBooks.length === 0) {
    return (
      <button className="btn btn-mark btn-block" onClick={() => go("catalog")}>
        <Icon.Plus/> Добавить книгу
      </button>
    );
  }

  return (
    <div style={{ position: "relative" }} ref={wrapRef}>
      <button className="btn btn-mark btn-block" onClick={() => setOpen((v) => !v)}>
        <Icon.Plus/> Новый чат
      </button>
      {open && (
        <div style={{ position: "absolute", left: 0, right: 0, top: "calc(100% + 6px)", background: "var(--cream)", border: "1px solid var(--rule)", borderRadius: "var(--r-lg)", boxShadow: "var(--shadow-lg)", zIndex: 50, padding: 8, maxHeight: 320, overflow: "auto" }}>
          <div className="mono" style={{ color: "var(--ink-faint)", padding: "6px 10px" }}>Выберите книгу</div>
          {myBooks.map((b) => (
            <button key={b.id} className="scope-item" onClick={() => { onPick(b.id); setOpen(false); }}
              style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "8px 10px", borderRadius: "var(--r-sm)", fontSize: 13, color: "var(--ink)", textAlign: "left", cursor: "pointer" }}>
              <div style={{ width: 22, flexShrink: 0 }}><BookCover book={b} size="sm"/></div>
              <div style={{ minWidth: 0, overflow: "hidden" }}>
                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.title}</div>
                <div style={{ fontSize: 11, color: "var(--ink-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.author}</div>
              </div>
            </button>
          ))}
          <style>{`.scope-item:hover { background: var(--paper-2); }`}</style>
        </div>
      )}
    </div>
  );
}

function SessionItem({ s, active, renaming, onClick, onStartRename, onRename, onCancelRename, onDelete }) {
  const [val, setVal] = useSC(s.title);
  const inputRef = useRC(null);
  useEC(() => { if (renaming) { setVal(s.title); inputRef.current?.focus(); inputRef.current?.select(); } }, [renaming]);

  const book = window.REMARKA.BOOKS.find((b) => b.id === s.bookId);
  const subtitle = book?.author || "Книга";

  return (
    <div className={`session-item ${active ? "active" : ""}`} onClick={onClick}>
      <div className="si-icon">
        {book ? <BookCover book={book} size="sm"/> :
          <div style={{ width: "100%", aspectRatio: "2/3", background: "var(--ink)", color: "var(--paper)", borderRadius: 3, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon.Book/>
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

function ChatWelcome({ scopeBook }) {
  if (!scopeBook) {
    return (
      <div style={{ textAlign: "center", paddingTop: 40 }}>
        <h2 style={{ fontSize: 24 }}>Книга не выбрана</h2>
        <p className="soft" style={{ fontSize: 15, marginTop: 14 }}>Выберите книгу из вашей полки слева.</p>
      </div>
    );
  }
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

function ContextPanel({ book, citesByQuestion, totalCites, focus, setFocus, flashCite, onScrollToMsg, openReader, onBook }) {
  if (!book) {
    return (
      <div style={{ padding: "24px 22px" }}>
        <div className="soft" style={{ fontSize: 13 }}>Книга не выбрана.</div>
      </div>
    );
  }

  return (
    <div style={{ padding: "24px 22px 32px" }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
        <div className="mono" style={{ color: "var(--mark)" }}>Контекст разговора</div>
      </div>

      {/* Шапка-карточка книги */}
      <div style={{ display: "grid", gridTemplateColumns: "56px 1fr", gap: 14, padding: "14px", background: "var(--cream)", border: "1px solid var(--rule)", borderRadius: "var(--r)", marginBottom: 18 }}>
        <div><BookCover book={book} size="sm"/></div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: "var(--f-serif)", fontSize: 15, lineHeight: 1.25 }}>{book.title}</div>
          <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 4 }}>{book.author}</div>
          <button className="btn btn-plain btn-sm" style={{ paddingLeft: 0, marginTop: 8 }} onClick={() => onBook(book.id)}>
            <Icon.Book/> Открыть разбор
          </button>
        </div>
      </div>

      {/* Табы */}
      <div className="ctx-tabs" role="tablist" style={{ marginBottom: 14 }}>
        <button className={`ctx-tab ${focus === "info" ? "is-active" : ""}`} onClick={() => setFocus("info")} role="tab" aria-selected={focus === "info"}>
          О книге
        </button>
        <button className={`ctx-tab ${focus === "cites" ? "is-active" : ""}`} onClick={() => setFocus("cites")} role="tab" aria-selected={focus === "cites"}
          disabled={totalCites === 0} style={{ opacity: totalCites === 0 ? 0.5 : 1 }}>
          Цитаты {totalCites > 0 && <span className="ctx-tab-count">{totalCites}</span>}
        </button>
      </div>

      {focus === "info" || totalCites === 0 ? (
        <div className="ctx-info">
          {book.year && <div className="mono ctx-info-line"><span>Год</span><b>{book.year}</b></div>}
          {book.pages && <div className="mono ctx-info-line"><span>Объём</span><b>{book.pages} стр.</b></div>}
          {book.tags && book.tags.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
              {book.tags.slice(0, 6).map((t) => (
                <span key={t} className="badge" style={{ fontSize: 10 }}>{t}</span>
              ))}
            </div>
          )}
          {totalCites === 0 && (
            <div className="soft" style={{ fontSize: 12, lineHeight: 1.5, marginTop: 18 }}>
              Цитаты появятся здесь, когда Ремарка ответит на ваш вопрос.
            </div>
          )}
        </div>
      ) : (
        <div className="ctx-cites">
          {citesByQuestion.map((qg, qi) => (
            <div key={qi} className="ctx-q-group">
              <button className="ctx-q-head" onClick={() => qg.qMsgIdx != null && onScrollToMsg(qg.qMsgIdx)} title={qg.q} disabled={qg.qMsgIdx == null}>
                <span className="ctx-q-text">{qg.q}</span>
                <svg className="ctx-q-jump" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M13 5l7 7-7 7"/>
                </svg>
              </button>
              <div className="ctx-q-cites">
                {qg.items.map((it, ii) => {
                  const isFlash = flashCite && flashCite.msgIdx === it.msgIdx && flashCite.citeIdx === it.citeIdx;
                  return (
                    <button
                      key={ii}
                      className={`ctx-cite-card ${isFlash ? "is-flash" : ""}`}
                      onClick={() => openReader?.(book.id, it.c)}
                      title={it.c.q ? `${it.c.ch} · стр. ${it.c.p} — ${it.c.q}` : `${it.c.ch} · стр. ${it.c.p}`}>
                      <span className="mono ctx-cite-ref">стр. {it.c.p}</span>
                      {it.c.q && <span className="ctx-cite-q">{it.c.q}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
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
              <button key={i} className="badge" onClick={() => onCite(c, i)} style={{ cursor: "pointer" }}>
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

function decl(n, forms) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

Object.assign(window, { ScreenChat });
