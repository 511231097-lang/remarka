import { redirect } from "next/navigation";

interface EntityDetailsRedirectPageProps {
  params: Promise<{ projectId: string; entityId: string }>;
}

export const dynamic = "force-dynamic";

export default async function EntityDetailsRedirectPage({ params }: EntityDetailsRedirectPageProps) {
  const { projectId, entityId } = await Promise.resolve(params);
  redirect(`/projects/${projectId}?entity=${entityId}`);
}
