import type { Metadata } from "next";
import { HomeRouteClient } from "./_route-clients/HomeRouteClient";

export const metadata: Metadata = {
  title: "Immojudis - Ventes immobilieres judiciaires",
  description:
    "Explorez les ventes aux encheres immobilieres judiciaires avec annonces analysees, alertes et mise plafond.",
};

export default function Page() {
  return <HomeRouteClient />;
}
