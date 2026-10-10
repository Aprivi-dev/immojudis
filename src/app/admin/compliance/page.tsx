import type { Metadata } from "next";
import { AdminCompliancePage } from "@/routes/admin.compliance";

export const metadata: Metadata = {
  title: "Conformité admin",
  description: "Suivi des demandes réglementaires Immojudis.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <AdminCompliancePage />;
}
