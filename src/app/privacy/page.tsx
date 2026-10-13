import type { Metadata } from "next";
import { PrivacyPage } from "@/routes/privacy";

export const metadata: Metadata = {
  alternates: { canonical: "/privacy" },
  title: "Confidentialité",
  description:
    "Politique de confidentialité d’Immojudis : traitements de données, durées, destinataires, cookies et exercice de vos droits.",
};

export default function Page() {
  return <PrivacyPage />;
}
