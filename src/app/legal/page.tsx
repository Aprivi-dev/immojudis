import type { Metadata } from "next";
import { LegalRouteClient } from "../_route-clients/LegalRouteClient";

export const metadata: Metadata = {
  title: "Mentions legales",
  description: "Mentions legales Immojudis.",
};

export default function Page() {
  return <LegalRouteClient />;
}
