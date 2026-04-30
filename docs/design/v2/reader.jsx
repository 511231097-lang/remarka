// Ридер: модалка, открывает книгу на нужной странице с подсветкой цитаты.
// Текст книги — синтетический, чтобы показать UX. На реальной странице сюда
// подгрузится фрагмент из bookId на странице cite.p.
const { useState: useSR, useEffect: useER, useRef: useRR, useMemo: useMR } = React;

// Заранее заготовленный псевдо-абзац — для "ткани" страницы вокруг цитаты.
const FILLER = [
  "Свет лампы лежал на столе плотным жёлтым кругом, и за пределами этого круга комната казалась пустой, словно её выгребли изнутри. Часы били далеко, через две стены, но он всё равно их слышал — каждый удар отзывался под рёбрами короткой судорогой, будто внутри что-то ещё пыталось спорить со временем.",
  "Он давно перестал записывать дни — это было первой вещью, от которой он отказался, когда понял, что считать больше нечего. Зато он научился слушать тишину так, как слушают музыку: не дожидаясь нот, а отмечая паузы между ними.",
  "Ему хотелось встать и подойти к окну, но он остался сидеть. В последние недели каждое его движение требовало от него чуть больше согласия с самим собой, чем он мог себе позволить за раз — и он экономил, как экономят керосин в долгую зиму.",
  "Где-то внизу хлопнула дверь подъезда. Звук поднялся по лестнице, постоял на площадке и растаял. Ему показалось, что в этот короткий промежуток времени в доме никого не было — ни жильцов, ни охраны, ни даже его самого.",
  "Он вспомнил разговор, который случился вчера, и понял, что тогда уже всё было решено — просто он не сразу это услышал. Слова часто опаздывают за смыслом; смысл идёт впереди и оборачивается, ждёт, пока язык догонит.",
  "За стеной кто-то засмеялся, коротко и сухо. Этот смех не имел отношения ни к нему, ни к комнате, ни к этой ночи — он принадлежал другой жизни, которая шла рядом, не пересекаясь.",
  "Бумага под рукой была холоднее самой ладони. Он знал, что если сейчас начать писать, то получится не то, что он хотел сказать, а то, что он мог сказать — и это разное. Он боялся этого зазора так же, как раньше боялся темноты.",
  "Потом стало тихо. Не той тишиной, которая случается между шумами, а той, которую слышишь, когда понимаешь, что больше уже ничего не будет — ни сегодня, ни, может быть, завтра.",
];

function makePage(bookId, page, cite) {
  // Случайно, но детерминированно выбираем 6 параграфов из FILLER, и один из них
  // заменяем цитатой (если она есть).
  const seed = (bookId.length * 31 + page) % FILLER.length;
  const out = [];
  for (let i = 0; i < 6; i++) out.push(FILLER[(seed + i) % FILLER.length]);
  return out;
}

function Reader({ open, bookId, cite, onClose }) {
  const book = useMR(() => window.REMARKA.BOOKS.find((b) => b.id === bookId), [bookId]);
  const [page, setPage] = useSR(cite?.p || 1);
  const highlightRef = useRR(null);
  const scrollRef = useRR(null);

  useER(() => { if (open && cite?.p) setPage(cite.p); }, [open, cite?.p, bookId]);

  // Прокрутка к подсветке при открытии и смене страницы
  useER(() => {
    if (!open) return;
    const t = setTimeout(() => {
      if (highlightRef.current && scrollRef.current) {
        const sc = scrollRef.current;
        const el = highlightRef.current;
        const y = el.offsetTop - sc.clientHeight / 2 + el.clientHeight / 2;
        sc.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
      } else if (scrollRef.current) {
        scrollRef.current.scrollTo({ top: 0 });
      }
    }, 60);
    return () => clearTimeout(t);
  }, [open, page, cite?.q]);

  // Esc — закрыть
  useER(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setPage((p) => Math.min((book?.pages || 999), p + 1));
      if (e.key === "ArrowLeft") setPage((p) => Math.max(1, p - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, book]);

  if (!open || !book) return null;

  const paras = makePage(book.id, page, cite);
  // Если у цитаты есть q — вставим её в один из абзацев и подсветим
  const showQuote = cite && cite.q && cite.p === page;
  const insertAt = 2; // после второго абзаца

  return ReactDOM.createPortal(
    <div className="reader-root" role="dialog" aria-label={`Чтение: ${book.title}`}>
      <div className="reader-backdrop" onClick={onClose}/>
      <div className="reader-window">
        <div className="reader-head">
          <div className="row-sm" style={{ minWidth: 0 }}>
            <div style={{ width: 28, flexShrink: 0 }}><BookCover book={book} size="sm"/></div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: "var(--f-serif)", fontSize: 14, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{book.title}</div>
              <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 2 }}>
                {cite?.ch || `Страница ${page}`}{cite ? ` · стр. ${cite.p}` : ""}
              </div>
            </div>
          </div>
          <div className="row-sm">
            <div className="mono" style={{ color: "var(--ink-muted)", marginRight: 6 }}>Ремарка нашла цитату</div>
            <button className="reader-close" onClick={onClose} aria-label="Закрыть">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </div>

        <div ref={scrollRef} className="reader-scroll">
          <div className="reader-page">
            <div className="mono reader-pageno">— стр. {page} —</div>
            {paras.map((p, i) => (
              <React.Fragment key={i}>
                <p className="reader-para">{p}</p>
                {showQuote && i === insertAt && (
                  <p className="reader-para">
                    <span ref={highlightRef} className="reader-mark">{cite.q}</span>
                  </p>
                )}
              </React.Fragment>
            ))}
            <div className="reader-pageno mono" style={{ marginTop: 36, textAlign: "center" }}>· · ·</div>
          </div>
        </div>

        <div className="reader-foot">
          <button className="btn btn-plain btn-sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>
            Стр. {page - 1}
          </button>
          <div className="mono" style={{ color: "var(--ink-muted)" }}>
            {cite?.q ? "Найденный фрагмент подсвечен" : "Свободное чтение"}
          </div>
          <button className="btn btn-plain btn-sm" onClick={() => setPage((p) => Math.min(book.pages || 999, p + 1))}>
            Стр. {page + 1}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 18l6-6-6-6"/></svg>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

window.Reader = Reader;
