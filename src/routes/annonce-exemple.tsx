import { createFileRoute } from "@tanstack/react-router";
import { SaleDetailView } from "@/components/SaleDetailView";
import { EXAMPLE_MARKET_ESTIMATE, EXAMPLE_SALE } from "@/lib/example-sale";
import { saleSeoTitle } from "@/lib/seo";

export const Route = createFileRoute("/annonce-exemple")({
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
  return <SaleDetailView sale={EXAMPLE_SALE} marketEstimateOverride={EXAMPLE_MARKET_ESTIMATE} />;
}
