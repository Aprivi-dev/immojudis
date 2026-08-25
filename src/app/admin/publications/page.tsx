import type { Metadata } from "next";
import { AuthGate } from "@/components/AuthGate";
import { AdminDashboardPage } from "@/routes/admin";

export const metadata: Metadata = {
  title: "Publications admin",
  description: "Validation des demandes de publication ImmoJudis.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <AuthGate>
      <AdminDashboardPage initialView="publications" />
    </AuthGate>
  );
}
