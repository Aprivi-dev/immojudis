import type { Metadata } from "next";
import { getExampleSaleRecords, isExampleSaleKey } from "@/lib/example-sale";
import { ExampleSalePage } from "@/routes/annonce-exemple";

// Indexed on purpose: it is the public illustration of what the offers add. The
// "Exemple fictif" banner and the absence of structured data keep it from being
// mistaken for a real listing.
export const metadata: Metadata = {
  title: "Annonce exemple : l’analyse d’une vente au tribunal",
  description:
    "Exemple fictif d’analyse Immojudis pour un appartement vendu au tribunal : mise à prix, valeur estimée, frais, travaux, risques et plafond d’enchère.",
  alternates: { canonical: "/annonce-exemple" },
  robots: { index: true, follow: true },
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Page({ searchParams }: PageProps) {
  const requested = (await searchParams).bien;
  const key = isExampleSaleKey(requested) ? requested : "bordeaux";
  // Dates are computed now (hearing in 21 days), never frozen at build time.
  return <ExampleSalePage example={getExampleSaleRecords()[key]} />;
}
