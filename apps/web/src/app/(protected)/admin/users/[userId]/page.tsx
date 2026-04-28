import type { AdminMetricsWindow } from "@/lib/adminMetrics";
import { AdminUserDetailPage } from "@/components/admin/AdminUserDetailPage";

interface RoutePageProps {
  params: Promise<{ userId: string }>;
  searchParams: Promise<{ window?: string }>;
}

function normalizeWindow(value: string | undefined): AdminMetricsWindow {
  if (value === "24h" || value === "7d" || value === "30d" || value === "90d" || value === "all") {
    return value;
  }
  return "30d";
}

export default async function AdminUserDetailRoutePage(props: RoutePageProps) {
  const params = await props.params;
  const searchParams = await props.searchParams;
  return <AdminUserDetailPage userId={params.userId} initialWindow={normalizeWindow(searchParams.window)} />;
}
