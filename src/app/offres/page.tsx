import type { Metadata } from "next";
import { OffersPage } from "./offers-page";

export const metadata: Metadata = {
  alternates: { canonical: "/offres" },
  title: "Offres Découverte et Analyse",
  description:
    "Découverte est gratuite. Analyse chiffre votre enchère plafond, suit les nouvelles ventes avec des alertes et s’appuie sur des ventes comparables réelles : 29 € TTC par mois.",
};

export default function Page() {
  return <OffersPage />;
}
