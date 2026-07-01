import type { Metadata } from "next";
import { PublishRouteClient } from "../_route-clients/PublishRouteClient";

export const metadata: Metadata = {
  title: "Publier une vente",
  description:
    "Preparer une demande de publication de vente aux encheres immobiliere avec documents et validation admin.",
};

export default function Page() {
  return <PublishRouteClient />;
}
