import { createFileRoute } from "@/lib/router-compat";
import { AnalysisSaleDetailView, FreeSaleDetailView } from "@/components/SimplifiedSaleDetailView";
import { EXAMPLE_MARKET_ESTIMATE, EXAMPLE_SALE } from "@/lib/example-sale";
import { saleSeoTitle } from "@/lib/seo";

export const Route = createFileRoute("/annonce-exemple")({
  validateSearch: (search: Record<string, unknown>) => ({
    offre: search.offre === "decouverte" ? ("decouverte" as const) : ("analyse" as const),
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

function ExampleSalePage() {
  const { offre } = Route.useSearch<{ offre: "decouverte" | "analyse" }>();
  if (offre === "decouverte") {
    return <FreeSaleDetailView sale={EXAMPLE_SALE} />;
  }
  return (
    <AnalysisSaleDetailView sale={EXAMPLE_SALE} marketEstimateOverride={EXAMPLE_MARKET_ESTIMATE} />
  );
}
