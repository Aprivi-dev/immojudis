import type { Metadata } from "next";
import { ContactRouteClient } from "../_route-clients/ContactRouteClient";

export const metadata: Metadata = {
  title: "Contact",
  description: "Contacter l'equipe Immojudis.",
};

export default function Page() {
  return <ContactRouteClient />;
}
