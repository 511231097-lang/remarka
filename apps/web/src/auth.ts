import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import YandexProvider from "next-auth/providers/yandex";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@remarka/db";

const hasGoogleConfig = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const hasYandexConfig = Boolean(process.env.YANDEX_CLIENT_ID && process.env.YANDEX_CLIENT_SECRET);

type ProviderConfig = NextAuthOptions["providers"][number];
const providers: ProviderConfig[] = [];

if (hasGoogleConfig) {
  providers.push(
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
      // Linking — для случая когда пользователь сначала логинится через
      // Yandex с email X, а потом пытается через Google с тем же email.
      // Без этого NextAuth выдаст OAuthAccountNotLinked. Безопасно потому
      // что Google возвращает верифицированный email.
      allowDangerousEmailAccountLinking: true,
    }),
  );
}

if (hasYandexConfig) {
  providers.push(
    YandexProvider({
      clientId: process.env.YANDEX_CLIENT_ID as string,
      clientSecret: process.env.YANDEX_CLIENT_SECRET as string,
      // Аналогично Google — пользователь, у которого уже есть аккаунт
      // через Google, может захотеть войти через Яндекс с тем же email.
      // Yandex возвращает верифицированный email из default_email/emails[],
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
