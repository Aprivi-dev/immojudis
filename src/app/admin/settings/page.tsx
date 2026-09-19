import type { Metadata } from "next";
import { AuthGate } from "@/components/AuthGate";
import { AdminDashboardPage } from "@/routes/admin";

export const metadata: Metadata = {
  title: "Configuration admin — ImmoJudis",
  description: "Réglages de collecte, limites IA et configuration des services.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <AuthGate>
      <AdminDashboardPage initialView="settings" />
    </AuthGate>
  );
}
