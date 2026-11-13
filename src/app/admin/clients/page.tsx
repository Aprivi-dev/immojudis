import type { Metadata } from "next";
import { AdminClientsPage } from "./admin-clients-page";

export const metadata: Metadata = {
  title: "Clients et abonnements admin",
  description: "Gestion des accès et abonnements Immojudis.",
};

export default function Page() {
  return <AdminClientsPage />;
}
