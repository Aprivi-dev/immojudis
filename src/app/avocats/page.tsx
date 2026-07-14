import type { Metadata } from "next";
import { LawyerDirectoryRouteClient } from "../_route-clients/LawyerDirectoryRouteClient";

export const metadata: Metadata = {
  title: "Annuaire des avocats en ventes judiciaires — Immojudis",
  description:
    "Trouvez un avocat référencé pour vérifier votre dossier et porter vos enchères judiciaires.",
};

export default function Page() {
  return <LawyerDirectoryRouteClient />;
}
