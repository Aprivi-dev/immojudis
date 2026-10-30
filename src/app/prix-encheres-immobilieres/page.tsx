import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BreadcrumbJsonLd } from "@/components/BreadcrumbJsonLd";
import { pageMetadata } from "@/lib/page-metadata";
import { PUBLIC_ADJUDICATION_PRICES_PATH } from "@/lib/public-adjudication-prices";
import { loadPublicAdjudicationPrices } from "@/lib/public-adjudication-prices.server";
import { PricesUnavailable, PricesView } from "./prices-view";

// Aucune lecture ne se fait tant que `PUBLIC_ADJUDICATION_PRICES_ENABLED` n'est pas exactement
// « true » : la page répond alors 404 (avant tout envoi, donc avec un vrai statut 404 et
// `noindex`). Ouverte, elle est rafraîchie toutes les heures (Next.js veut un littéral ici) :
// une lecture ratée pendant une panne ne reste donc pas jusqu'au prochain déploiement.
export const revalidate = 3600;

const NOT_INDEXED = { index: false, follow: false } as const;

export async function generateMetadata(): Promise<Metadata> {
  const result = await loadPublicAdjudicationPrices();
  // Fermée, ou ouverte sans chiffres à montrer : jamais dans l'index.
  if (result.status !== "ok") {
    return { title: "Prix des adjudications", robots: NOT_INDEXED };
  }
  return {
    ...pageMetadata({
      path: PUBLIC_ADJUDICATION_PRICES_PATH,
      title: "Prix réels des adjudications immobilières",
      description:
        "Prix final médian rapporté à la mise à prix, part des ventes adjugées au-dessus de la mise et ventilation par type de bien, avec période, effectif et méthode.",
    }),
    robots: { index: true, follow: true },
  };
}

export default async function Page() {
  const result = await loadPublicAdjudicationPrices();
  if (result.status === "disabled") notFound();
  return (
    <>
      <BreadcrumbJsonLd
        trail={[{ name: "Prix des adjudications", path: PUBLIC_ADJUDICATION_PRICES_PATH }]}
      />
      {result.status === "ok" ? <PricesView data={result.data} /> : <PricesUnavailable />}
    </>
  );
}
