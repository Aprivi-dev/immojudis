import type { Metadata } from "next";
import { AuthGate } from "@/components/AuthGate";
import { ComparisonsPage } from "@/components/ComparisonsPage";

export const metadata: Metadata = {
  title: "Mes comparaisons",
  description: "Retrouvez vos comparaisons de ventes immobilières enregistrées.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <AuthGate>
      <ComparisonsPage />
    </AuthGate>
  );
}
