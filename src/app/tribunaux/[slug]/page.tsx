import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { BreadcrumbJsonLd } from "@/components/BreadcrumbJsonLd";
import { departmentFromCode, departmentItemListStructuredData } from "@/lib/department-pages";
import { jsonLdString } from "@/lib/json-ld";
import { pageMetadata } from "@/lib/page-metadata";
import type { PublicTribunalActivity } from "@/lib/public-tribunal-activity";
import { loadPublicTribunalActivity } from "@/lib/public-tribunal-activity.server";
import { tryLoadPublicTribunalDirectory } from "@/lib/public-tribunal-directory.server";
import { resolveSiteOrigin } from "@/lib/site-url";
import {
  TRIBUNAL_PAGES_PATH,
  emptyTribunalActivity,
  hasReadableTribunalName,
  isTribunalPageIndexable,
  knownTribunalFromSlug,
  legacyTribunalRedirectPath,
  nextAudienceDate,
  normalizeTribunalSlug,
  tribunalPageDescription,
  tribunalPageFromSlug,
  tribunalPagePath,
  tribunalPages,
  type TribunalPage,
  tribunalActivityWithoutDuplicates,
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

type Resolved =
  | { kind: "active"; items: PublicTribunalActivity[]; page: TribunalPage }
  /** Tribunal connu du référentiel qui n'a aucune vente à venir : page servie, hors index. */
  | { kind: "empty"; items: PublicTribunalActivity[]; page: TribunalPage }
  /** Ancienne adresse (nom du tribunal) : redirection permanente vers l'adresse par code. */
  | { kind: "redirect"; path: string }
  | { kind: "unknown" };

/**
 * Le tribunal de l'adresse. L'adresse vient du code du tribunal : elle ne change pas quand ses
 * ventes à venir apparaissent ou disparaissent. D'abord les tribunaux qui ont des ventes (activité
 * publique), puis le référentiel complet (page « aucune vente à venir »), puis les anciennes
 * adresses par nom (redirection). Lève une erreur si la base est indisponible : jamais de 404
 * déduit d'une panne, la réponse n'est alors pas mise en cache.
 */
async function resolvePage(slug: string): Promise<Resolved> {
  const resolved = await resolveExactSlug(slug);
  if (resolved.kind !== "unknown") return resolved;
  // « Bobigny », « JUSTICE-TJ-1-210 », « justice_tj_1_210 » : une adresse mal écrite se redirige
  // (308) vers l'adresse publiée, elle ne répond pas 404.
  const normalized = normalizeTribunalSlug(slug);
  if (!normalized || normalized === slug) return resolved;
  const retry = await resolveExactSlug(normalized);
  if (retry.kind === "active" || retry.kind === "empty") {
    return { kind: "redirect", path: retry.page.path };
  }
  return retry;
}

async function resolveExactSlug(slug: string): Promise<Resolved> {
  const activity = await loadPublicTribunalActivity();
  if (activity.status === "error") throw new Error("Activité publique des tribunaux indisponible.");
  const page = tribunalPageFromSlug(activity.items, slug);
  if (page) return { kind: "active", items: activity.items, page };

  const directory = await tryLoadPublicTribunalDirectory();
  if (directory.status === "error") throw new Error("Référentiel des tribunaux indisponible.");
  const known = knownTribunalFromSlug(directory.items, slug);
  if (known) {
    const emptyActivity = emptyTribunalActivity(known);
    return {
      kind: "empty",
      items: activity.items,
      page: { activity: emptyActivity, slug, path: tribunalPagePath(known.code) },
    };
  }
  const path = legacyTribunalRedirectPath(activity.items, directory.items, slug);
  return path ? { kind: "redirect", path } : { kind: "unknown" };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const resolved = await resolvePage((await params).slug);
  if (resolved.kind === "unknown" || resolved.kind === "redirect") {
    return { title: "Tribunal introuvable", robots: { index: false, follow: false } };
  }
  const { page } = resolved;
  const sales = resolved.kind === "active" ? await tryLoadTribunalSales(page.activity.code) : null;
  // Le nombre annoncé est celui de la liste dédoublonnée (même règle que la page).
  const activity = {
    ...tribunalActivityWithoutDuplicates(page.activity, sales),
    nextSaleDate: nextAudienceDate(page.activity, sales?.status === "ok" ? sales.sales : null),
  };
  return {
    ...pageMetadata({
      path: page.path,
      title: tribunalPageTitle(activity),
      description: tribunalPageDescription(activity),
    }),
    // Moins de trois ventes à venir (aucune comprise), ou un tribunal que le référentiel ne nomme
    // pas : page consultable, mais sans intérêt pour un moteur de recherche. Elle reste hors du
    // sitemap (même règle) et ses liens sont suivis.
    ...(isTribunalPageIndexable(activity.upcomingCount) && hasReadableTribunalName(activity)
      ? {}
      : { robots: { index: false, follow: true } }),
  };
}

export default async function Page({ params }: PageProps) {
  const resolved = await resolvePage((await params).slug);
  if (resolved.kind === "unknown") notFound();
  // Avant toute écriture de la réponse : un vrai 308, pas une redirection côté client.
  if (resolved.kind === "redirect") permanentRedirect(resolved.path);
  const { items, page } = resolved;

  // Un tribunal sans vente à venir n'a rien à lire : la page le dit, sans interroger la base.
  const sales =
    resolved.kind === "active"
      ? await tryLoadTribunalSales(page.activity.code)
      : ({ status: "ok", sales: [], received: 0 } as const);
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
  // Compteur et liste parlent des mêmes ventes : les doublons écartés de la liste le sont aussi du total.
  const { mayCountDuplicates, ...tribunal } = tribunalActivityWithoutDuplicates(
    page.activity,
    sales,
  );
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
        tribunal={tribunal}
        nextAudience={nextAudienceDate(page.activity, sales.status === "ok" ? listed : null, now)}
        sales={listed}
        salesAvailable={sales.status === "ok"}
        countMayIncludeDuplicates={mayCountDuplicates}
        department={department}
        siblings={siblings}
        generatedAt={now}
      />
    </>
  );
}
