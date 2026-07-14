import type { Metadata } from "next";
import { LawyerDirectoryRouteClient } from "../_route-clients/LawyerDirectoryRouteClient";

export const metadata: Metadata = {
  title: "Annuaire des avocats en droit immobilier — Immojudis",
  description:
    "Trouvez un avocat en droit immobilier par barreau et identifiez clairement les profils partenaires sponsorisés.",
};

export default function Page() {
  return <LawyerDirectoryRouteClient />;
}
