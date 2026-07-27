import type { Metadata } from "next";
import { Suspense } from "react";
import { SaleDetailRouteClient } from "@/app/_route-clients/SaleDetailRouteClient";
import { formatPrice } from "@/lib/format";
import { getSaleById, getSalePreviewById } from "@/lib/queries";
import { saleSeoTitle } from "@/lib/seo";
import { resolveSiteOrigin } from "@/lib/site-url";

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
    alternates: {
      canonical: `/sales/${id}`,
    },
  };
}

export default async function Page({ params }: PageProps) {
  const { id } = await params;
  const data = await loadSaleDetail(id);
  const visibleSale = data.sale ?? data.preview;
  const siteOrigin = resolveSiteOrigin(process.env, "http://localhost:3000")!;
  const structuredData = visibleSale
    ? {
        "@context": "https://schema.org",
        "@type": "RealEstateListing",
        name: saleSeoTitle(visibleSale),
        url: `${siteOrigin}/sales/${id}`,
        address: {
          "@type": "PostalAddress",
          addressLocality: visibleSale.city ?? undefined,
          postalCode: visibleSale.postal_code ?? undefined,
          addressCountry: "FR",
        },
        offers:
          visibleSale.starting_price_eur == null
            ? undefined
            : {
                "@type": "Offer",
                price: visibleSale.starting_price_eur,
                priceCurrency: "EUR",
                availability: "https://schema.org/LimitedAvailability",
              },
      }
    : null;

  return (
    <>
      {structuredData ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
          }}
        />
      ) : null}
      <Suspense fallback={<SaleDetailFallback sale={visibleSale} />}>
        <SaleDetailRouteClient id={id} loaderData={data} />
      </Suspense>
    </>
  );
}

function SaleDetailFallback({
  sale,
}: {
  sale: Awaited<ReturnType<typeof loadSaleDetail>>["preview"];
}) {
  return (
    <main className="min-h-screen bg-[#f7f5f3] px-4 py-10 text-foreground sm:px-6">
      <section className="mx-auto max-w-3xl rounded-lg border border-border bg-white p-6 shadow-sm sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-soft">
          Vente judiciaire
        </p>
        <h1 className="mt-3 font-display text-3xl leading-tight sm:text-4xl">
          {saleSeoTitle(sale)}
        </h1>
        <dl className="mt-6 grid gap-4 rounded-md border border-border bg-muted/30 p-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Mise à prix
            </dt>
            <dd className="mt-1 text-xl font-semibold">
              {sale?.starting_price_eur == null
                ? "À consulter"
                : formatPrice(sale.starting_price_eur)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Localisation
            </dt>
            <dd className="mt-1 font-medium">{sale?.city ?? "Localisation à confirmer"}</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
