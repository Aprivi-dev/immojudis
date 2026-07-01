import type { Metadata } from "next";
import { ResourcesRouteClient } from "../_route-clients/ResourcesRouteClient";

export const metadata: Metadata = {
  title: "Ventes immobilieres judiciaires",
  description:
    "Guide des ventes immobilieres judiciaires : procedure, risques, financement et methode d'analyse.",
};

export default function Page() {
  return <ResourcesRouteClient />;
}
