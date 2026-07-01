import type { Metadata } from "next";
import { AboutRouteClient } from "../_route-clients/AboutRouteClient";

export const metadata: Metadata = {
  title: "A propos",
  description: "La mission Immojudis et l'approche produit.",
};

export default function Page() {
  return <AboutRouteClient />;
}
