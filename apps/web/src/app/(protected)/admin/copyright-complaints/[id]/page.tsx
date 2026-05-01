import { AdminCopyrightComplaintDetailPage } from "@/components/admin/AdminCopyrightComplaintDetailPage";

interface RouteProps {
  params: Promise<{ id: string }>;
}

export default async function AdminCopyrightComplaintDetailRoute({ params }: RouteProps) {
  const { id } = await params;
  return <AdminCopyrightComplaintDetailPage complaintId={id} />;
}
