import Link from "next/link";

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-border bg-card/70">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-5 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>© {year} Литанализ</p>
        <div className="flex flex-wrap items-center gap-4">
          <Link href="/about" className="text-primary hover:underline">
            О проекте
          </Link>
          <Link href="/cookie-policy" className="text-primary hover:underline">
            Соглашение об использовании cookie
          </Link>
        </div>
      </div>
    </footer>
  );
}
