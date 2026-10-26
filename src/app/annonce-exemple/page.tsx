import type { Metadata } from "next";
import { getExampleSaleRecords, isExampleSaleKey } from "@/lib/example-sale";
import { resolveSiteOrigin } from "@/lib/site-url";
import { pageMetadata } from "@/lib/page-metadata";
import { ExampleSalePage } from "./example-sale-page";

// Indexed on purpose: it is the public illustration of what the offers add. The
// "Exemple fictif" banner and the absence of structured data keep it from being
// mistaken for a real listing.
export const metadata: Metadata = {
  ...pageMetadata({
    path: "/annonce-exemple",
    title: "Annonce exemple : analyse d’une vente",
    description:
      "Exemple fictif d’analyse Immojudis pour un appartement vendu au tribunal : mise à prix, valeur estimée, frais, travaux, risques et enchère plafond.",
  }),
  robots: { index: true, follow: true },
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Page({ searchParams }: PageProps) {
  const requested = (await searchParams).bien;
  const key = isExampleSaleKey(requested) ? requested : "bordeaux";
  // Dates are computed now (hearing in 21 days), never frozen at build time.
  return (
    <ExampleSalePage
      example={
        getExampleSaleRecords(new Date(), resolveSiteOrigin(process.env, "http://localhost:3000"))[
          key
        ]
      }
      adjudicationStatisticsEnabled={process.env.ADJUDICATION_PRICE_STATISTICS_ENABLED === "true"}
    />
  );
}
