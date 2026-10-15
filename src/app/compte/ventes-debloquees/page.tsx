import type { Metadata } from "next";
import { AuthGate } from "@/components/AuthGate";
import { UnlockedSalesPage } from "@/components/UnlockedSalesPage";

export const metadata: Metadata = {
  title: "Mes ventes débloquées",
  description: "Les ventes que j’ai débloquées avec mon compte Découverte.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <AuthGate>
      <UnlockedSalesPage />
    </AuthGate>
  );
}
