import type { Metadata } from "next";
import { AuthGate } from "@/components/AuthGate";
import { AdminDashboardPage } from "@/routes/admin";

export const metadata: Metadata = {
  title: "Clients et abonnements admin",
  description: "Gestion des accès et abonnements ImmoJudis.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <AuthGate>
      <AdminDashboardPage initialView="clients" />
    </AuthGate>
  );
}
