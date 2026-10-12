import type { Metadata } from "next";
import { AdminOperationsPage } from "./admin-operations-page";

export const metadata: Metadata = {
  title: "Opérations admin",
  description: "Collecte, enrichissement et suivi des traitements Immojudis.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <AdminOperationsPage />;
}
