import { redirect } from "next/navigation";
import { Profile } from "@/components/Profile";
import { resolveAuthUser } from "@/lib/authUser";

export default async function ProfilePage() {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    redirect("/signin");
  }

  return (
    <Profile
      authUser={{
        name: authUser.name,
        email: authUser.email,
        image: authUser.image,
        tier: authUser.tier,
        tierActivatedAt: authUser.tierActivatedAt
          ? authUser.tierActivatedAt.toISOString()
          : null,
      }}
    />
  );
}
