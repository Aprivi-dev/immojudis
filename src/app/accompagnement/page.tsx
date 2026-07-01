import type { Metadata } from "next";
import { AccompagnementRouteClient } from "../_route-clients/AccompagnementRouteClient";

export const metadata: Metadata = {
  title: "Accompagnement",
  description: "Un accompagnement pour cadrer une enchere immobiliere judiciaire.",
};

export default function Page() {
  return <AccompagnementRouteClient />;
}
