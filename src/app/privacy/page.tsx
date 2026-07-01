import type { Metadata } from "next";
import { PrivacyRouteClient } from "../_route-clients/PrivacyRouteClient";

export const metadata: Metadata = {
  title: "Confidentialite",
  description: "Politique de confidentialite Immojudis.",
};

export default function Page() {
  return <PrivacyRouteClient />;
}
