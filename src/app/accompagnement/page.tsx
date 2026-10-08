import type { Metadata } from "next";
import { AccompagnementPage } from "@/routes/accompagnement";

export const metadata: Metadata = {
  alternates: { canonical: "/accompagnement" },
  title: "Offres Découverte et Analyse",
  description:
    "Découverte gratuite avec trois favoris. Analyse propose sept jours d’essai avec carte bancaire, puis un abonnement aux outils Premium.",
};

export default function Page() {
  return <AccompagnementPage />;
}
