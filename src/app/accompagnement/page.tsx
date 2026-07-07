import type { Metadata } from "next";
import { AccompagnementRouteClient } from "../_route-clients/AccompagnementRouteClient";

export const metadata: Metadata = {
  title: "Offre Pro",
  description:
    "Offre Immojudis Pro : rapports d'opportunite, comparables DVF, alertes avancees, calcul de mise maximale et avocats references.",
};

export default function Page() {
  return <AccompagnementRouteClient />;
}
