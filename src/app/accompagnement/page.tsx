import type { Metadata } from "next";
import { AccompagnementRouteClient } from "../_route-clients/AccompagnementRouteClient";

export const metadata: Metadata = {
  title: "Offres Découverte et Analyse",
  description:
    "Découverte gratuite puis Analyse complète à 29 euros pour 30 jours, sans abonnement récurrent.",
};

export default function Page() {
  return <AccompagnementRouteClient />;
}
