import type { Metadata } from "next";
import { CloudBackgroundPreload } from "@/components/CloudBackgroundPreload";
import { TermsPage } from "@/routes/conditions-generales";

export const metadata: Metadata = {
  alternates: { canonical: "/conditions-generales" },
  title: "Conditions générales",
  description:
    "Conditions générales d’Immojudis : description des offres, commande, prix et paiement, compte, réclamations et droit applicable.",
};

export default function Page() {
  // Précharge ici et non dans `TermsPage` : ce fichier est ancré par son sha256 (legal-documents).
  return (
    <>
      <CloudBackgroundPreload />
      <TermsPage />
    </>
  );
}
