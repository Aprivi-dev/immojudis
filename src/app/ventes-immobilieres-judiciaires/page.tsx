import type { Metadata } from "next";
import { ResourcesPage } from "./resources-guide";

export const metadata: Metadata = {
  alternates: { canonical: "/ventes-immobilieres-judiciaires" },
  title: "Ventes immobilières judiciaires",
  description:
    "Guide des ventes immobilières judiciaires : procédure, risques, financement et méthode d'analyse.",
};

export default function Page() {
  return <ResourcesPage />;
}
