import type { Metadata } from "next";
import { AuthGate } from "@/components/AuthGate";
import { AdminDashboardPage } from "@/routes/admin";

export const metadata: Metadata = {
  title: "Agent IA admin",
  description: "Configuration du template de prise de contact de l’agent IA ImmoJudis.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <AuthGate>
      <AdminDashboardPage initialView="agent" />
    </AuthGate>
  );
}
