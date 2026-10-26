import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { parseOpenFeeRegimes } from "@/lib/fee-regime";
import { lookupPublicSale } from "@/lib/public-sale.server";
import {
  GENERIC_SALE_SEO_TITLE,
  isIndexablePublicSale,
  saleSeoDescription,
  saleSeoTitle,
  saleStructuredData,
} from "@/lib/seo";
import { resolveSiteOrigin } from "@/lib/site-url";
import { SaleDetailPage } from "./sale-detail-page";
import { jsonLdString } from "@/lib/json-ld";

type PageProps = {
  params: Promise<{ id: string }>;
};

const NOT_INDEXED = { index: false, follow: false } as const;
/** A thin page stays out of the index, but its links (to the catalogue, courts…) are followed. */
const THIN_PAGE = { index: false, follow: true } as const;

function salePath(saleId: string): string {
  return `/sales/${saleId.toLowerCase()}`;
}

// The public page of a sale is identical for every visitor: it is generated on
// first request, served from the cache, and refreshed at most every 5 minutes. The database
// read itself is cached and tagged `sale-<id>` in `lookupPublicSale`; the pipeline expires
// the tag and this page through `POST /api/pipeline/revalidate-sale` (P6-06). The value below
// must equal PUBLIC_SALE_REVALIDATE_SECONDS (a test checks it): Next.js wants a literal.
// An unknown sale calls notFound(): the response carries the 404 page, a real 404 status and
// `noindex`. An identifier removed by a duplicate merge calls permanentRedirect() to the kept sale
// (308), under the same condition. The status is fixed by the first streamed chunk. It stays right
// here because the page is generated as a whole (static generation, then ISR) even though `loading.tsx` files
// (./loading.tsx, ../loading.tsx) wrap it in Suspense: they only show during client navigation.
// A dynamic render (`connection()` in the layout, see `cspRequiresDynamicRendering`) would send
// the fallback first and turn the status into a 200: those `loading.tsx` files would then have
// to go. There is deliberately no root `app/loading.tsx` (it made `/comparaisons/<unknown>` a
// 200), and `scripts/check-production-smoke.mjs` checks that an unknown identifier answers 404.
export const revalidate = 300;

export async function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const lookup = await lookupPublicSale(id);

  // A merged duplicate only redirects (see Page): nothing to announce, nothing to index.
  if (lookup.status === "merged") {
    return { title: GENERIC_SALE_SEO_TITLE, robots: NOT_INDEXED };
  }

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
  // The identifier of the URL is case-insensitive: the address announced to search engines is
  // always the lower-case one of the sale itself.
  const path = salePath(lookup.sale.id);
  // The database verdict (same predicate as the sitemap) wins; the TypeScript copy only decides
  // while that function is not deployed.
  const indexable = lookup.indexable ?? isIndexablePublicSale(lookup.sale);
  return {
    ...(indexable ? {} : { robots: THIN_PAGE }),
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      url: path,
      siteName: "Immojudis",
      locale: "fr_FR",
      // A page-level openGraph replaces the layout's: without an image, shares of a sale would
      // have no preview.
      images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: "Immojudis" }],
    },
    twitter: { card: "summary_large_image", title, description, images: ["/opengraph-image"] },
    alternates: {
      canonical: path,
    },
  };
}

export default async function Page({ params }: PageProps) {
  const { id } = await params;
  const lookup = await lookupPublicSale(id);
  // Answered while the page is generated as a whole, before anything is streamed: crawlers get
  // a real 404 status (see the note on `revalidate`).
  if (lookup.status === "missing") notFound();
  // A duplicate merged into another sale: permanent redirect (308) to the sale that was kept, which
  // is in the public catalogue. Same moment as the 404 above, before anything is streamed.
  if (lookup.status === "merged") permanentRedirect(salePath(lookup.targetId));

  const sale = lookup.status === "found" ? lookup.sale : null;
  const siteOrigin = resolveSiteOrigin(process.env, "http://localhost:3000")!;
  const structuredData = sale
    ? saleStructuredData({ ...sale, id: sale.id.toLowerCase() }, { origin: siteOrigin })
    : null;

  return (
    <>
      {structuredData ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: jsonLdString(structuredData),
          }}
        />
      ) : null}
      <SaleDetailPage
        id={id}
        initialData={{ sale: null, preview: sale }}
        adjudicationStatisticsEnabled={process.env.ADJUDICATION_PRICE_STATISTICS_ENABLED === "true"}
        openFeeRegimes={parseOpenFeeRegimes(process.env.CEILING_FEE_REGIMES_OPEN)}
      />
    </>
  );
}
