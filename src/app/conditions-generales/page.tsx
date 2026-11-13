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
  return <TermsPage />;
}
