import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __remarkaPrisma: PrismaClient | undefined;
}

export const prisma = globalThis.__remarkaPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__remarkaPrisma = prisma;
}
