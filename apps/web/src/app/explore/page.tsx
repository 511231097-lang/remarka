import { Explore } from "@/components/Explore";
import { resolveAuthUser } from "@/lib/authUser";

export default async function ExplorePage() {
  const authUser = await resolveAuthUser();
  return <Explore isAuthenticated={Boolean(authUser)} />;
}
