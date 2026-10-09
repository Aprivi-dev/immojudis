import type { Metadata } from "next";
import { AuthGate } from "@/components/AuthGate";
import { AdminSecurityPage } from "@/components/admin/AdminSecurityPage";

export const metadata: Metadata = {
  title: "Sécurité admin — ImmoJudis",
  description: "Double authentification du compte administrateur.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <AuthGate>
      <AdminSecurityPage />
    </AuthGate>
  );
}
