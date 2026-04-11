import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/auth";
import { Profile } from "@/components/Profile";

export default async function ProfilePage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    redirect("/signin");
  }

  return (
    <Profile
      authUser={{
        name: session.user.name || null,
        email: session.user.email || null,
        image: session.user.image || null,
      }}
    />
  );
}
