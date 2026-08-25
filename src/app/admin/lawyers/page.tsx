import type { Metadata } from "next";
import { AuthGate } from "@/components/AuthGate";
import { AdminDashboardPage } from "@/routes/admin";

export const metadata: Metadata = {
  title: "Avocats admin",
  description: "Gestion du réseau d’avocats et des mises en relation ImmoJudis.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <AuthGate>
      <AdminDashboardPage initialView="lawyers" />
    </AuthGate>
  );
}
