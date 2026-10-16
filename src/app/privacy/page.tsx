import type { Metadata } from "next";
import { CloudBackgroundPreload } from "@/components/CloudBackgroundPreload";
import { PrivacyPage } from "@/routes/privacy";

export const metadata: Metadata = {
  alternates: { canonical: "/privacy" },
  title: "Confidentialité",
  description:
    "Politique de confidentialité d’Immojudis : traitements de données, durées, destinataires, cookies et exercice de vos droits.",
};

export default function Page() {
  // Précharge ici et non dans `PrivacyPage` : ce fichier est ancré par son sha256 (legal-documents).
  return (
    <>
      <CloudBackgroundPreload />
      <PrivacyPage />
    </>
  );
}
