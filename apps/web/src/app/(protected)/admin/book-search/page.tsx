import { Suspense } from "react";
import { AdminBookSearchPage } from "@/components/admin/AdminBookSearchPage";

export default function AdminBookSearchRoutePage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Загрузка...</p>}>
      <AdminBookSearchPage />
    </Suspense>
  );
}
