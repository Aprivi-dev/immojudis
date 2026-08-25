import type { Metadata } from "next";
import { TribunalsPage } from "@/routes/tribunaux";

export const metadata: Metadata = {
  title: "Statistiques des ventes judiciaires par tribunal",
  description:
    "Fourchettes de mises à prix, délais observés et calendrier des ventes judiciaires suivies par tribunal.",
  robots: { index: true, follow: true },
};

export default function Page() {
  return <TribunalsPage />;
}
