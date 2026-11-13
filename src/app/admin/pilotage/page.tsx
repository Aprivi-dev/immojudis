import type { Metadata } from "next";
import { AdminPilotagePage } from "./admin-pilotage-page";

export const metadata: Metadata = {
  title: "Pilotage",
  description: "Agrégats de pilotage Immojudis sur 7 et 30 jours.",
};

export default function Page() {
  return <AdminPilotagePage />;
}
