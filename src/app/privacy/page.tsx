import type { Metadata } from "next";
import { pageMetadata } from "@/lib/page-metadata";
import { courtRegistryDailyCap } from "@/lib/information-agent/court-registry-fallback";
import { PrivacyPage } from "@/routes/privacy";

export const metadata: Metadata = pageMetadata({
  path: "/privacy",
  title: "Confidentialité",
  description:
    "Politique de confidentialité d’Immojudis : traitements de données, durées, destinataires, cookies et exercice de vos droits.",
});

export default function Page() {
  // Précharge ici et non dans `PrivacyPage` : ce fichier est ancré par son sha256 (legal-documents).
  return (
    <>
      <PrivacyPage courtRegistryDailyCap={courtRegistryDailyCap()} />
    </>
  );
}
