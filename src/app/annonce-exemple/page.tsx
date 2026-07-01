import type { Metadata } from "next";
import { ExampleSaleRouteClient } from "../_route-clients/ExampleSaleRouteClient";

export const metadata: Metadata = {
  title: "Annonce exemple",
  description: "Exemple de fiche analysee Immojudis.",
};

export default function Page() {
  return <ExampleSaleRouteClient />;
}
