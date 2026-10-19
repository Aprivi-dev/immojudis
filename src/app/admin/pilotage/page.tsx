import type { Metadata } from "next";
import { AdminPilotagePage } from "./admin-pilotage-page";

export const metadata: Metadata = {
  title: "Pilotage",
  description: "Agrégats de pilotage Immojudis sur 7 et 30 jours.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <AdminPilotagePage />;
}
