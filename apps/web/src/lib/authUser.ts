import { prisma } from "@remarka/db";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";

export interface AuthUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  defaultBookVisibilityPublic: boolean;
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
      defaultBookVisibilityPublic: true,
    },
  });

  if (!user) return null;
  return user;
}
