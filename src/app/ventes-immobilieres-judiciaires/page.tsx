import type { Metadata } from "next";
import { BreadcrumbJsonLd } from "@/components/BreadcrumbJsonLd";
import { pageMetadata } from "@/lib/page-metadata";
import { ResourcesPage } from "./resources-guide";

// Page pilier : le titre est posé tel quel (sans le suffixe du modèle du layout) et tient en
// 60 caractères au plus. Le h1 de la page garde son propre intitulé.
const title = "Vente judiciaire immobilière : guide de l’adjudication";
const description =
  "Le guide des enchères judiciaires : procédure, frais à prévoir, risques à vérifier et méthode d’analyse, de l’annonce à l’adjudication du bien.";

export const metadata: Metadata = pageMetadata({
  path: "/ventes-immobilieres-judiciaires",
  title: { absolute: title },
  description,
});

export default function Page() {
  return (
    <>
      <BreadcrumbJsonLd
        trail={[
          { name: "Ventes immobilières judiciaires", path: "/ventes-immobilieres-judiciaires" },
        ]}
      />
      <ResourcesPage />
    </>
  );
}
