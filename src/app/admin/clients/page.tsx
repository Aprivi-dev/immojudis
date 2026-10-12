import type { Metadata } from "next";
import { AdminClientsPage } from "./admin-clients-page";

export const metadata: Metadata = {
  title: "Clients et abonnements admin",
  description: "Gestion des accès et abonnements Immojudis.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <AdminClientsPage />;
}
