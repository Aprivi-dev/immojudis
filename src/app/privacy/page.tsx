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
  // Enveloppe hors du fichier soumis à l'empreinte du document : les panneaux des sections y perdent leur
  // flou d'arrière-plan (src/styles.css, .legal-document).
  return (
    <div className="legal-document">
      <PrivacyPage courtRegistryDailyCap={courtRegistryDailyCap()} />
    </div>
  );
}
