import type { Metadata } from "next";
import { AdminSignupsPage } from "./admin-signups-page";

export const metadata: Metadata = {
  title: "Inscriptions admin",
  description: "Comptes inscrits sur Immojudis et prolongation de l'essai gratuit.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <AdminSignupsPage />;
}
