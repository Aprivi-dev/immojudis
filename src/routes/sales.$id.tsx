import { useEffect } from "react";
import { createFileRoute, Link } from "@/lib/router-compat";
import { useQuery } from "@tanstack/react-query";
import {
  SaleDetailSkeleton,
  SaleDetailView,
  SaleErrorComponent,
  SaleNotFoundComponent,
} from "@/components/SaleDetailView";
import { DiscoverySaleDetailView } from "@/components/DiscoverySaleDetailView";
import { useAuth } from "@/hooks/use-auth";
import { markSaleViewed } from "@/hooks/use-viewed-sales";
import { formatPrice } from "@/lib/format";
import { getSaleById, getSalePreviewById } from "@/lib/queries";
import { fetchFeatureEntitlements } from "@/lib/client-api";
import { safeSalesReturnTo, saleDetailPath } from "@/lib/navigation";
import { saleSeoTitle } from "@/lib/seo";
import type { AuctionSale } from "@/lib/types";

type SaleDetailRouteData = {
  sale: AuctionSale | null;
  preview: AuctionSale | null;
};

async function loadSaleDetailRouteData(
  id: string,
  options: { discovery?: boolean } = {},
): Promise<SaleDetailRouteData> {
  const sale = await getSaleById(id, options);
  if (sale) return { sale, preview: null };
  return { sale: null, preview: await getSalePreviewById(id) };
}

export const Route = createFileRoute("/sales/$id")({
  validateSearch: (search: Record<string, unknown>) => {
    const from = safeSalesReturnTo(search.from);
    return from ? { from } : {};
  },
  // The route loader cannot know the viewer's paid entitlement. It therefore
  // fetches only the public teaser; the component selects the curated
  // Découverte or Analyse view after the entitlement request completes.
  loader: async ({ params }) => ({
    sale: null,
    preview: await getSalePreviewById(params.id),
  }),
  head: ({ loaderData }) => {
    const visibleSale = loaderData?.sale ?? loaderData?.preview ?? null;
    const title = saleSeoTitle(visibleSale);
    return {
      meta: [
        { title },
        { property: "og:title", content: title },
        {
          name: "description",
          content:
            visibleSale?.starting_price_eur != null
              ? `Vente immobilière judiciaire Immojudis avec mise à prix ${formatPrice(
                  visibleSale.starting_price_eur,
                )}. Connectez-vous pour consulter l'analyse complète du dossier.`
              : "Vente immobilière judiciaire Immojudis : consultez l'analyse complète du dossier après connexion.",
        },
      ],
    };
  },
  component: SaleDetailPage,
  errorComponent: SaleErrorComponent,
  notFoundComponent: SaleNotFoundComponent,
});

function SaleDetailPage() {
  const { id } = Route.useParams();
  const { from } = Route.useSearch<{ from?: string }>();
  const returnTo = from ?? "/sales";
  const initialData = Route.useLoaderData<SaleDetailRouteData | undefined>();
  const { session, loading: authLoading } = useAuth();
  const sessionKey = session?.user.id ?? "anonymous";
  const { data: entitlementsData, isLoading: entitlementsLoading } = useQuery({
    queryKey: ["feature-entitlements", sessionKey],
    queryFn: fetchFeatureEntitlements,
    enabled: Boolean(session) && !authLoading,
    staleTime: 5 * 60_000,
  });
  const discovery = Boolean(session) && entitlementsData?.plan.hasAnalysisAccess !== true;
  const accessReady = !session || !entitlementsLoading;
  const canUseServerInitialData = Boolean(initialData?.sale);
  const { data, isLoading, error } = useQuery({
    queryKey: ["sale-detail", id, sessionKey, discovery ? "discovery" : "analysis"],
    queryFn: () => loadSaleDetailRouteData(id, { discovery }),
    enabled: !authLoading && accessReady,
    initialData: canUseServerInitialData ? initialData : undefined,
    staleTime: 5 * 60_000,
  });
  const sale = data?.sale ?? null;
  const preview = data?.preview ?? null;

  useEffect(() => {
    if (sale?.id) markSaleViewed(sale.id);
  }, [sale?.id]);

  if (authLoading || entitlementsLoading || !accessReady || isLoading) {
    return <SaleDetailSkeleton />;
  }
  if (error) throw error;
  if (!sale && preview) {
    return <SalePublicPreview saleId={id} preview={preview} returnTo={returnTo} />;
  }
  if (!sale) return <SaleNotFoundComponent />;

  return discovery ? (
    <DiscoverySaleDetailView sale={sale} returnTo={returnTo} />
  ) : (
    <SaleDetailView sale={sale} returnTo={returnTo} />
  );
}

function SalePublicPreview({
  saleId,
  preview,
  returnTo,
}: {
  saleId: string;
  preview: AuctionSale;
  returnTo: string;
}) {
  const price = formatPrice(preview.starting_price_eur);

  return (
    <main className="min-h-screen bg-[#f7f5f3] px-4 py-10 text-foreground sm:px-6">
      <section className="mx-auto max-w-3xl rounded-lg border border-border bg-white p-6 shadow-sm sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-soft">
          Fiche publique
        </p>
        <h1 className="mt-3 font-display text-3xl leading-tight text-foreground sm:text-4xl">
          Vente judiciaire Immojudis
        </h1>
        <dl className="mt-6 grid gap-3 rounded-md border border-border bg-muted/30 p-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Mise à prix
            </dt>
            <dd className="mt-1 text-xl font-semibold text-foreground">{price}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Accès dossier
            </dt>
            <dd className="mt-1 text-sm font-medium text-foreground">Connexion requise</dd>
          </div>
        </dl>
        <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
          Les documents, risques, estimation de marché, coordonnées avocat et analyses détaillées
          sont réservés à l'offre Analyse. Créez gratuitement votre compte pour découvrir le
          catalogue et prévisualiser tous les enrichissements disponibles.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            to="/login"
            search={{
              mode: "investor",
              redirect: saleDetailPath(saleId, returnTo),
            }}
            className="inline-flex items-center justify-center rounded-md bg-gold-soft px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-gold"
          >
            Créer un compte Découverte
          </Link>
          <Link
            to={returnTo}
            className="inline-flex items-center justify-center rounded-md border border-border bg-white px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft"
          >
            Retour aux ventes
          </Link>
        </div>
      </section>
    </main>
  );
}
