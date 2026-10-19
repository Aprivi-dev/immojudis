import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BreadcrumbJsonLd } from "@/components/BreadcrumbJsonLd";
import { departmentFromCode, departmentItemListStructuredData } from "@/lib/department-pages";
import { jsonLdString } from "@/lib/json-ld";
import { pageMetadata } from "@/lib/page-metadata";
import { loadPublicTribunalActivity } from "@/lib/public-tribunal-activity.server";
import { resolveSiteOrigin } from "@/lib/site-url";
import {
  TRIBUNAL_PAGES_PATH,
  isTribunalPageIndexable,
  nextAudienceDate,
  tribunalPageDescription,
  tribunalPageFromSlug,
  tribunalPages,
  tribunalPageTitle,
  tribunalPlaceName,
} from "@/lib/tribunal-pages";
import { tryLoadTribunalSales } from "@/lib/tribunal-pages.server";
import { TribunalView } from "../tribunal-view";

type PageProps = { params: Promise<{ slug: string }> };

// Comme les pages département et la fiche d'une vente : page produite à la première demande,
// servie depuis le cache et rafraîchie au plus toutes les heures (Next.js veut un littéral ici ; il
// doit rester égal à TRIBUNAL_SALES_REVALIDATE_SECONDS et à
// PUBLIC_TRIBUNAL_ACTIVITY_REVALIDATE_SECONDS, un test le vérifie). Une base indisponible lève une
// erreur : la réponse n'est pas mise en cache, et une version déjà produite reste servie.
export const revalidate = 3600;

export async function generateStaticParams() {
  return [];
}

/**
 * Le tribunal de l'adresse, d'après l'activité publique (un tribunal sans vente à venir n'y figure
 * pas : sa page n'existe plus). Lève une erreur si la base est indisponible.
 */
async function loadPage(slug: string) {
  const activity = await loadPublicTribunalActivity();
  if (activity.status === "error") throw new Error("Activité publique des tribunaux indisponible.");
  return { items: activity.items, page: tribunalPageFromSlug(activity.items, slug) };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { page } = await loadPage((await params).slug);
  if (!page) {
    return { title: "Tribunal introuvable", robots: { index: false, follow: false } };
  }
  const sales = await tryLoadTribunalSales(page.activity.code);
  const activity = {
    ...page.activity,
    nextSaleDate: nextAudienceDate(page.activity, sales.status === "ok" ? sales.sales : null),
  };
  return {
    ...pageMetadata({
      path: page.path,
      title: tribunalPageTitle(activity),
      description: tribunalPageDescription(activity),
    }),
    // Moins de trois ventes à venir : page consultable, mais sans intérêt pour un moteur de
    // recherche. Elle reste hors du sitemap (même seuil) et ses liens sont suivis.
    ...(isTribunalPageIndexable(activity.upcomingCount)
      ? {}
      : { robots: { index: false, follow: true } }),
  };
}

export default async function Page({ params }: PageProps) {
  const { items, page } = await loadPage((await params).slug);
  if (!page) notFound();

  const sales = await tryLoadTribunalSales(page.activity.code);
  const department = departmentFromCode(page.activity.department);
  const siblings = department
    ? tribunalPages(items).filter(
        (other) =>
          other.activity.code !== page.activity.code &&
          departmentFromCode(other.activity.department)?.code === department.code,
      )
    : [];
  const now = new Date();
  const listed = sales.status === "ok" ? sales.sales : [];
  const origin = resolveSiteOrigin(process.env, "http://localhost:3000")!;
  const itemList = departmentItemListStructuredData(origin, listed);

  return (
    <>
      <BreadcrumbJsonLd
        trail={[
          { name: "Tribunaux", path: TRIBUNAL_PAGES_PATH },
          {
            name: tribunalPlaceName(page.activity.searchName || page.activity.name),
            path: page.path,
          },
        ]}
      />
      {itemList ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLdString(itemList) }}
        />
      ) : null}
      <TribunalView
        tribunal={page.activity}
        nextAudience={nextAudienceDate(page.activity, sales.status === "ok" ? listed : null, now)}
        sales={listed}
        salesAvailable={sales.status === "ok"}
        department={department}
        siblings={siblings}
        generatedAt={now}
      />
    </>
  );
}
