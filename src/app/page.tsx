import type { Metadata } from "next";
import { HomeRouteClient } from "./_route-clients/HomeRouteClient";

export const metadata: Metadata = {
  title: "Immojudis - L'immobilier judiciaire en toute clarté",
  description:
    "L'immobilier judiciaire en toute clarté : rapports d'opportunité, comparables DVF, alertes avancées et mise maximale avant audience.",
};

export default function Page() {
  return <HomeRouteClient />;
}
