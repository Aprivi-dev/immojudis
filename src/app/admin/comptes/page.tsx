import type { Metadata } from "next";
import { AdminAccountsPage } from "./admin-accounts-page";

export const metadata: Metadata = {
  title: "Comptes admin",
  description: "Inscriptions, essai gratuit et accès payants Immojudis.",
};

export default function Page() {
  return <AdminAccountsPage />;
}
