import type { Metadata } from "next";
import { SalesRouteClient } from "../_route-clients/SalesRouteClient";

export const metadata: Metadata = {
  title: "Annonces",
  description: "Consultez toutes les ventes aux encheres immobilieres disponibles.",
};

export default function Page() {
  return <SalesRouteClient />;
}
