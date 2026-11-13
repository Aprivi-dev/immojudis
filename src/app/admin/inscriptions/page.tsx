import type { Metadata } from "next";
import { AdminSignupsPage } from "./admin-signups-page";

export const metadata: Metadata = {
  title: "Inscriptions admin",
  description: "Comptes inscrits sur Immojudis et prolongation de l'essai gratuit.",
};

export default function Page() {
  return <AdminSignupsPage />;
}
