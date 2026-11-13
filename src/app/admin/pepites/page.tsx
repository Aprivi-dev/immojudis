import type { Metadata } from "next";
import { AdminPepitesPage } from "./admin-pepites-page";

export const metadata: Metadata = {
  title: "Pépites",
  description: "Résultats de la règle des pépites sur le catalogue réel, avant toute publication.",
};

export default function Page() {
  return <AdminPepitesPage />;
}
