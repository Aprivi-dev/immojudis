"use client";

import { TribunalJudicialActivityExplorer } from "@/components/TribunalJudicialActivityExplorer";
import { createFileRoute } from "@/lib/router-compat";

export const Route = createFileRoute("/tribunaux")({
  head: () => ({
    meta: [
      { title: "Statistiques des ventes judiciaires par tribunal — Immojudis" },
      {
        name: "description",
        content:
          "Fourchettes de mises à prix, délais observés et calendrier des ventes judiciaires suivies par tribunal.",
      },
    ],
  }),
  component: TribunalsPage,
});

export function TribunalsPage() {
  return <TribunalJudicialActivityExplorer />;
}
