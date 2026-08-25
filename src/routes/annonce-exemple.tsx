"use client";

import { createFileRoute } from "@/lib/router-compat";
import { AnalysisSaleDetailView } from "@/components/SimplifiedSaleDetailView";
import {
  EXAMPLE_SALE,
  EXAMPLE_SALE_RECORDS,
  isExampleSaleKey,
  type ExampleSaleKey,
} from "@/lib/example-sale";
import { saleSeoTitle } from "@/lib/seo";

export const Route = createFileRoute("/annonce-exemple")({
  validateSearch: (search: Record<string, unknown>) => ({
    bien: isExampleSaleKey(search.bien) ? search.bien : ("bordeaux" as const),
  }),
  head: () => ({
    meta: [
      { title: saleSeoTitle(EXAMPLE_SALE) },
      { property: "og:title", content: saleSeoTitle(EXAMPLE_SALE) },
      {
        name: "description",
        content:
          "Consultez une annonce Immojudis d'exemple avec photos fictives, pieces analysees, risques, marche local et mise plafond.",
      },
    ],
  }),
  component: ExampleSalePage,
});

export function ExampleSalePage() {
  const { bien } = Route.useSearch<{ bien: ExampleSaleKey }>();
  const example = EXAMPLE_SALE_RECORDS[bien];

  return (
    <AnalysisSaleDetailView
      sale={example.sale}
      marketEstimateOverride={example.marketEstimate}
      returnTo="/#exemples"
      backLabel="Retour aux exemples"
      publicDemo
    />
  );
}
