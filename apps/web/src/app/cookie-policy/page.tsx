export default function CookiePolicyPage() {
  return (
    <main className="min-h-full bg-background">
      <div className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-3xl text-foreground">Соглашение об использовании cookie</h1>
        <p className="mt-3 text-sm text-muted-foreground">Актуально на 20 апреля 2026</p>

        <section className="mt-8 space-y-4 text-sm leading-7 text-foreground">
          <h2 className="text-xl">1. Что такое cookie</h2>
          <p>
            Cookie — это небольшие текстовые файлы, которые сохраняются в браузере и помогают сайту распознавать
            устройство пользователя между запросами.
          </p>
        </section>

        <section className="mt-8 space-y-4 text-sm leading-7 text-foreground">
          <h2 className="text-xl">2. Какие cookie мы используем</h2>
          <p>
            Мы используем технические cookie, необходимые для авторизации, поддержания пользовательской сессии и
            корректной работы интерфейса.
          </p>
        </section>

        <section className="mt-8 space-y-4 text-sm leading-7 text-foreground">
          <h2 className="text-xl">3. Для чего используются cookie</h2>
          <p>Cookie помогают:</p>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>сохранять вход в аккаунт;</li>
            <li>защищать доступ к приватным разделам;</li>
            <li>фиксировать согласие на использование cookie.</li>
          </ul>
        </section>

        <section className="mt-8 space-y-4 text-sm leading-7 text-foreground">
          <h2 className="text-xl">4. Срок хранения и управление</h2>
          <p>
            Вы можете удалить cookie через настройки браузера. Отключение cookie может повлиять на работу авторизации и
            защищенных разделов приложения.
          </p>
        </section>
      </div>
    </main>
  );
}
