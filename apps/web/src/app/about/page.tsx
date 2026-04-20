export default function AboutPage() {
  return (
    <main className="min-h-full bg-background">
      <div className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-3xl text-foreground">О проекте Литанализ</h1>
        <p className="mt-4 text-sm leading-7 text-muted-foreground">
          Литанализ — сервис для структурированного разбора художественных произведений. Он помогает исследовать
          персонажей, темы, ключевые события и цитаты в удобном формате.
        </p>

        <section className="mt-8 space-y-3">
          <h2 className="text-xl text-foreground">Что умеет сервис</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm leading-7 text-muted-foreground">
            <li>загрузка книги в формате FB2;</li>
            <li>автоматический запуск и трекинг анализа;</li>
            <li>просмотр витрины книги и экспертного чата;</li>
            <li>личная библиотека и управление своими книгами.</li>
          </ul>
        </section>

        <section className="mt-8 space-y-3">
          <h2 className="text-xl text-foreground">Назначение</h2>
          <p className="text-sm leading-7 text-muted-foreground">
            Проект предназначен для учебных и исследовательских задач, где важно быстро получить наглядную структуру
            произведения и перейти к более глубокому чтению.
          </p>
        </section>
      </div>
    </main>
  );
}
