import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthGate } from "@/components/AuthGate";
import { CreateAlertPage } from "@/components/CreateAlertPage";
import { PageLoadingSkeleton } from "@/components/PageLoadingSkeleton";

export const metadata: Metadata = {
  title: "Créer une alerte",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <AuthGate>
      {/* `useSearchParams()` demande une frontière Suspense. */}
      <Suspense fallback={<PageLoadingSkeleton />}>
        <CreateAlertPage />
      </Suspense>
    </AuthGate>
  );
}
