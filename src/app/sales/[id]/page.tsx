import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { lookupPublicSale } from "@/lib/public-sale.server";
import {
  GENERIC_SALE_SEO_TITLE,
  saleSeoDescription,
  saleSeoTitle,
  saleStructuredData,
} from "@/lib/seo";
import { resolveSiteOrigin } from "@/lib/site-url";
import { SaleDetailPage } from "@/routes/sales.$id";

type PageProps = {
  params: Promise<{ id: string }>;
};

const NOT_INDEXED = { index: false, follow: false } as const;

// The public page of a sale is identical for every visitor: it is generated on
// first request, served from the cache, and refreshed at most every 5 minutes.
// An unknown sale calls notFound(): the response carries the 404 page and
// `noindex`. Its HTTP status is still 200 while the root `app/loading.tsx` wraps
// every page in a Suspense boundary (the status is sent with the first streamed
// chunk); a real 404 needs that boundary removed or a check in `proxy.ts`.
export const revalidate = 300;

export async function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const lookup = await lookupPublicSale(id);

  // A sale that is not in the public catalogue must never be indexed, and the
  // generic title is kept when the server could not read the sale at all.
  if (lookup.status !== "found") {
    return {
      title: lookup.status === "missing" ? "Annonce introuvable" : GENERIC_SALE_SEO_TITLE,
      robots: NOT_INDEXED,
    };
  }

  // The root layout template appends " - Immojudis": the title must not repeat it.
  const title = saleSeoTitle(lookup.sale);
  const description = saleSeoDescription(lookup.sale);
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      url: `/sales/${id}`,
      siteName: "Immojudis",
      locale: "fr_FR",
    },
    twitter: { card: "summary_large_image", title, description },
    alternates: {
      canonical: `/sales/${id}`,
    },
  };
}

export default async function Page({ params }: PageProps) {
  const { id } = await params;
  const lookup = await lookupPublicSale(id);
  // Answered before any streaming starts, so crawlers get a real 404.
  if (lookup.status === "missing") notFound();

  const sale = lookup.status === "found" ? lookup.sale : null;
  const siteOrigin = resolveSiteOrigin(process.env, "http://localhost:3000")!;
  const structuredData = sale ? saleStructuredData(sale, { origin: siteOrigin }) : null;

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
      <SaleDetailPage
        id={id}
        initialData={{ sale: null, preview: sale }}
        adjudicationStatisticsEnabled={process.env.ADJUDICATION_PRICE_STATISTICS_ENABLED === "true"}
      />
    </>
  );
}
