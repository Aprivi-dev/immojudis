import type { Metadata } from "next";
import { AuthGate } from "@/components/AuthGate";
import { AdminQualityPage } from "@/routes/admin.quality";

export const metadata: Metadata = {
  title: "Qualite des donnees",
  description: "Suivi de qualite des donnees Immojudis.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <AuthGate>
      <AdminQualityPage />
    </AuthGate>
  );
}
