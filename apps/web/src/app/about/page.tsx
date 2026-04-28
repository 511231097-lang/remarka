import Link from "next/link";
import { ArrowRight } from "lucide-react";

export default function AboutPage() {
  return (
    <main className="container-narrow screen-fade" style={{ paddingBottom: 96, paddingTop: 72 }}>
      <div className="mono" style={{ color: "var(--mark)", marginBottom: 16 }}>О проекте</div>
      <h1 style={{ fontSize: "clamp(42px, 7vw, 58px)", letterSpacing: 0 }}>ремарка.</h1>
      <p className="soft" style={{ fontSize: 18, lineHeight: 1.7, marginTop: 22 }}>
        Литературный AI-сервис. На полях любой книги - ваш экземпляр с пометками, к которому можно вернуться.
      </p>
      <div className="legal-sections">
        <section className="legal-section">
          <h3>Что умеет сервис</h3>
          <p>Каталог готовых разборов, личная библиотека, загрузка книг, витрина анализа и экспертный чат с опорой на текст.</p>
        </section>
        <section className="legal-section">
          <h3>Назначение</h3>
          <p>Проект предназначен для учебных и исследовательских задач, где важно быстро увидеть структуру произведения и перейти к более глубокому чтению.</p>
        </section>
      </div>
      <Link className="btn btn-mark" href="/explore" style={{ marginTop: 32 }}>
        Открыть каталог <ArrowRight size={14} />
      </Link>
    </main>
  );
}
