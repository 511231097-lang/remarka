import { LegalPage } from "@/components/LegalPage";

interface LegalRoutePageProps {
  params: Promise<{ docKey: string }>;
}

export default async function LegalRoutePage({ params }: LegalRoutePageProps) {
  const { docKey } = await params;
  return <LegalPage docKey={docKey} />;
}
