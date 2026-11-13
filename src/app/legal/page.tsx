import type { Metadata } from "next";
import { pageMetadata } from "@/lib/page-metadata";
import { LegalPage } from "@/routes/legal";

export const metadata: Metadata = pageMetadata({
  path: "/legal",
  title: "Mentions légales",
  description:
    "Mentions légales d’Immojudis : éditeur et responsable de publication, hébergement, objet du service et propriété intellectuelle.",
});

export default function Page() {
  // Le précharge est ici et non dans `LegalPage` : le fichier de la route est ancré par son
  // sha256 dans `LEGAL_DOCUMENTS` (toute modification demande une nouvelle version du document).
  return (
    <>
      <LegalPage />
    </>
  );
}
