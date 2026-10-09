import type { Metadata } from "next";
import { AccountPage } from "@/components/AccountPage";
import { AuthGate } from "@/components/AuthGate";

export const metadata: Metadata = {
  title: "Mon compte",
  description: "Gérer mon abonnement, mon moyen de paiement et mes données personnelles.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <AuthGate>
      <AccountPage />
    </AuthGate>
  );
}
