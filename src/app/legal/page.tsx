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
  // Enveloppe hors du fichier soumis à l'empreinte du document : les panneaux des sections y perdent leur
  // flou d'arrière-plan (src/styles.css, .legal-document).
  return (
    <div className="legal-document">
      <LegalPage />
    </div>
  );
}
