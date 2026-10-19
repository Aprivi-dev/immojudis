import type { Metadata } from "next";
import { BreadcrumbJsonLd } from "@/components/BreadcrumbJsonLd";
import { ResourcesPage } from "./resources-guide";

// Page pilier : le titre est posé tel quel (sans le suffixe du modèle du layout) et tient en
// 60 caractères au plus. Le h1 de la page garde son propre intitulé.
const title = "Vente immobilière judiciaire : guide de l’adjudication";
const description =
  "Procédure, frais à prévoir, risques à vérifier et méthode d’analyse : le guide d’une vente immobilière judiciaire, de l’annonce à l’adjudication.";

export const metadata: Metadata = {
  alternates: { canonical: "/ventes-immobilieres-judiciaires" },
  title: { absolute: title },
  description,
  openGraph: {
    title,
    description,
    url: "/ventes-immobilieres-judiciaires",
    type: "website",
    siteName: "Immojudis",
    locale: "fr_FR",
    // Déclarée ici parce que l'openGraph d'une page remplace celui du layout : sans image, les
    // partages de cette page n'auraient pas d'aperçu.
    images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: "Immojudis" }],
  },
  twitter: { card: "summary_large_image", title, description, images: ["/opengraph-image"] },
};

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
