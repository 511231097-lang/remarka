import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { AUTH_SECRET } from "@/lib/runtimeEnv";

const PUBLIC_PATHS = ["/", "/signin", "/explore", "/plans", "/cookie-policy", "/about"];
const PUBLIC_API_PATHS = [
  "/api/health",
  "/api/legal/consent",
  "/api/legal/copyright-complaint",
];
// GET-only public API endpoints. POST/PUT/DELETE на этих путях идут через
// auth-gate (например POST /api/books = upload, требует сессию). Сами роуты
// дополнительно различают anonymous (читают только isPublic=true книги) vs
// auth (могут видеть свою библиотеку, чат, личные данные).
const PUBLIC_API_GET_PATHS: Array<string | RegExp> = [
  "/api/books",
  // Read-only обзор public-книги: метаданные, showcase, TOC, содержимое
  // глав. Sub-routes под /chat/, /library, /like, /analysis* остаются
  // под auth — middleware режет non-GET и сами эти роуты делают
  // resolveAuthUser() внутри.
  /^\/api\/books\/[^/]+$/,
  /^\/api\/books\/[^/]+\/showcase$/,
  /^\/api\/books\/[^/]+\/chapters$/,
  /^\/api\/books\/[^/]+\/chapters\/[^/]+$/,
];

function matchesPublicGet(pathname: string): boolean {
  return PUBLIC_API_GET_PATHS.some((rule) =>
    typeof rule === "string" ? rule === pathname : rule.test(pathname),
  );
}

function isPublicPath(pathname: string, method: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  if (pathname.startsWith("/explore/")) return true;
  if (pathname.startsWith("/plans/")) return true;
  if (pathname.startsWith("/legal/")) return true;
  // Обзор книги (без /chat) — чат сидит в (protected) layout и редиректит
  // анонима на /signin самостоятельно. Здесь пропускаем весь /book/...,
  // потому что server-component layout тонко контролирует chat-routes.
  if (pathname.startsWith("/book/")) return true;
  if (pathname.startsWith("/api/auth/")) return true;
  if (pathname.startsWith("/api/internal/")) return true;
  if (PUBLIC_API_PATHS.includes(pathname)) return true;
  if (method === "GET" && matchesPublicGet(pathname)) return true;
  return false;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublicPath(pathname, req.method)) {
    return NextResponse.next();
  }

  const token = await getToken({ req, secret: AUTH_SECRET });

  if (!token) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const signInUrl = new URL("/signin", req.url);
    signInUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};
