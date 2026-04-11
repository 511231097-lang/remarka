import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { Layout } from "@/components/Layout";
import { authOptions } from "@/auth";

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    redirect("/signin");
  }

  const userName = session.user.name?.trim() || session.user.email || "Пользователь";
  const userImage = session.user.image || null;

  return (
    <Layout userName={userName} userImage={userImage}>
      {children}
    </Layout>
  );
}
