import type { Metadata } from "next";
import { SaleDetailRouteClient } from "@/app/_route-clients/SaleDetailRouteClient";
import { formatPrice } from "@/lib/format";
import { getSaleById, getSalePreviewById } from "@/lib/queries";
import { saleSeoTitle } from "@/lib/seo";

type PageProps = {
  params: Promise<{ id: string }>;
};

async function loadSaleDetail(id: string) {
  const sale = await getSaleById(id);
  if (sale) return { sale, preview: null };
  return { sale: null, preview: await getSalePreviewById(id) };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const data = await loadSaleDetail(id);
  const visibleSale = data.sale ?? data.preview ?? null;
  const title = saleSeoTitle(visibleSale);

  return {
    title,
    description:
      visibleSale?.starting_price_eur != null
        ? `Vente immobiliere judiciaire Immojudis avec mise a prix ${formatPrice(
            visibleSale.starting_price_eur,
          )}. Connectez-vous pour consulter l'analyse complete du dossier.`
        : "Vente immobiliere judiciaire Immojudis : consultez l'analyse complete du dossier apres connexion.",
    openGraph: {
      title,
      description:
        visibleSale?.city != null
          ? `Vente judiciaire a ${visibleSale.city}.`
          : "Vente immobiliere judiciaire Immojudis.",
      type: "article",
    },
  };
}

export default async function Page({ params }: PageProps) {
  const { id } = await params;
  const data = await loadSaleDetail(id);
  return <SaleDetailRouteClient id={id} loaderData={data} />;
}
