import type { Metadata } from "next";
import { TribunalsPage } from "@/routes/tribunaux";

export const metadata: Metadata = {
  title: "Statistiques Tribunaux",
  description:
    "Comparez les prix d’adjudication, les mises à prix et les résultats des ventes judiciaires par tribunal et type de bien, avec les effectifs et la méthode de calcul.",
  robots: { index: true, follow: true },
};

export default function Page() {
  return <TribunalsPage />;
}
