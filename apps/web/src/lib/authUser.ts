import { prisma } from "@remarka/db";
import { getServerSession } from "next-auth";
import type { UserRole } from "@prisma/client";
import { authOptions } from "@/auth";

export interface AuthUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  role: UserRole;
}

export async function resolveAuthUser(): Promise<AuthUser | null> {
  const session = await getServerSession(authOptions);
  const email = String(session?.user?.email || "").trim();
  if (!email) return null;

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      role: true,
    },
  });

  if (!user) return null;
  return user;
}
