import type { NextAuthOptions } from "next-auth";
import YandexProvider from "next-auth/providers/yandex";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@remarka/db";

// Авторизация — только через Yandex ID (RU-домашний провайдер).
// Google OAuth удалён в legal-edition v1.2 — privacy policy теперь
// декларирует, что идентификационные данные пользователя в США не
// передаются, и Yandex остаётся единственным каналом auth.
//
// Существующие аккаунты с Account.provider='google' в БД — оставлены,
// чтобы не порвать ссылки в исторических данных. Логин через Google
// больше не работает (нет провайдера в config); legacy-юзерам нужно
// привязать Yandex-аккаунт по тому же e-mail (NextAuth автоматически
// связывает по верифицированному email если allowDangerousEmailAccountLinking
// — что здесь и стоит).

const hasYandexConfig = Boolean(process.env.YANDEX_CLIENT_ID && process.env.YANDEX_CLIENT_SECRET);

type ProviderConfig = NextAuthOptions["providers"][number];
const providers: ProviderConfig[] = [];

if (hasYandexConfig) {
  providers.push(
    YandexProvider({
      clientId: process.env.YANDEX_CLIENT_ID as string,
      clientSecret: process.env.YANDEX_CLIENT_SECRET as string,
      // Linking — если у legacy-пользователя в БД уже был Account через Google
      // с тем же email, Yandex-вход линкуется к тому же User row.
      // Yandex возвращает верифицированный email (default_email/emails[]),
      // так что объединение безопасно.
      allowDangerousEmailAccountLinking: true,
    }),
  );
}

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  providers,
  pages: {
    signIn: "/signin",
  },
  secret: process.env.AUTH_SECRET || "dev-insecure-secret",
  session: {
    strategy: "jwt",
  },
};
