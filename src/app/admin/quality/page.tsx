import type { Metadata } from "next";
import { AdminQualityRouteClient } from "../../_route-clients/AdminQualityRouteClient";

export const metadata: Metadata = {
  title: "Qualite des donnees",
  description: "Suivi de qualite des donnees Immojudis.",
};

export default function Page() {
  return <AdminQualityRouteClient />;
}
