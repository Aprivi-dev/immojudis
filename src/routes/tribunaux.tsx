"use client";

import { TribunalJudicialActivityExplorer } from "@/components/TribunalJudicialActivityExplorer";
import { createFileRoute } from "@/lib/router-compat";

export const Route = createFileRoute("/tribunaux")({
  head: () => ({
    meta: [
      { title: "Statistiques Tribunaux — Immojudis" },
      {
        name: "description",
        content:
          "Comparez les prix d’adjudication, les mises à prix et les résultats des ventes judiciaires par tribunal et type de bien, avec les effectifs et la méthode de calcul.",
      },
    ],
  }),
  component: TribunalsPage,
});

export function TribunalsPage() {
  return <TribunalJudicialActivityExplorer />;
}
