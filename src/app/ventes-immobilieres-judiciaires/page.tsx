import type { Metadata } from "next";
import { ResourcesPage } from "@/routes/ventes-immobilieres-judiciaires";

export const metadata: Metadata = {
  title: "Ventes immobilieres judiciaires",
  description:
    "Guide des ventes immobilieres judiciaires : procedure, risques, financement et methode d'analyse.",
};

export default function Page() {
  return <ResourcesPage />;
}
