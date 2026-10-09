import type { Metadata } from "next";
import { AuthGate } from "@/components/AuthGate";
import { AdminQualityPage } from "@/routes/admin.quality";

export const metadata: Metadata = {
  title: "Qualité des données",
  description: "Suivi de la qualité des données Immojudis.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <AuthGate>
      <AdminQualityPage />
    </AuthGate>
  );
}
