import type { Metadata } from "next";
import { AdminOperationsPage } from "@/routes/admin.operations";

export const metadata: Metadata = {
  title: "Opérations admin",
  description: "Collecte, enrichissement et suivi des traitements Immojudis.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <AdminOperationsPage />;
}
