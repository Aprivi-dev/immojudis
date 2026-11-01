import type { Metadata } from "next";
import { AdminEmailsPage } from "./admin-emails-page";

export const metadata: Metadata = {
  title: "Emails admin",
  description: "Aperçus, adresses d’envoi et domaines des emails d’Immojudis.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <AdminEmailsPage />;
}
