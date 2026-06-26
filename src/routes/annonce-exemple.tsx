import { createFileRoute } from "@tanstack/react-router";
import { SaleDetailView } from "@/components/SaleDetailView";
import { EXAMPLE_MARKET_ESTIMATE, EXAMPLE_SALE } from "@/lib/example-sale";

export const Route = createFileRoute("/annonce-exemple")({
  head: () => ({
    meta: [
      { title: "Annonce d'exemple Immojudis - page annonce publique" },
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
