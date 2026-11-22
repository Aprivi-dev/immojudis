import type { Metadata } from "next";
import { pageMetadata } from "@/lib/page-metadata";
import { TermsPage } from "@/routes/conditions-generales";

export const metadata: Metadata = pageMetadata({
  path: "/conditions-generales",
  title: "Conditions générales",
  description:
    "Conditions générales d’Immojudis : description des offres, commande, prix et paiement, compte, réclamations et droit applicable.",
});

export default function Page() {
  // Enveloppe hors du fichier soumis à l'empreinte du document : les panneaux des sections y perdent leur
  // flou d'arrière-plan (src/styles.css, .legal-document).
  return (
    <div className="legal-document">
      <TermsPage />
    </div>
  );
}
