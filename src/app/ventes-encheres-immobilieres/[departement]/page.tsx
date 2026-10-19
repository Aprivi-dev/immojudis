import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BreadcrumbJsonLd } from "@/components/BreadcrumbJsonLd";
import {
  DEPARTMENT_PAGES_PATH,
  departmentFromCode,
  departmentFromSlug,
  departmentItemListStructuredData,
  departmentPageDescription,
  departmentPageTitle,
  isDepartmentPageIndexable,
} from "@/lib/department-pages";
import { neighboringDepartmentCodes } from "@/lib/department-neighbors";
import { loadDepartmentCatalogue } from "@/lib/department-pages.server";
import { jsonLdString } from "@/lib/json-ld";
import { pageMetadata } from "@/lib/page-metadata";
import { loadPublicTribunalActivity } from "@/lib/public-tribunal-activity.server";
import { resolveSiteOrigin } from "@/lib/site-url";
import { DepartmentView } from "../department-view";

type PageProps = { params: Promise<{ departement: string }> };

// Comme la fiche d'une vente : page produite à la première demande, servie depuis le cache et
// rafraîchie au plus toutes les heures (Next.js veut un littéral ici ; il doit rester égal à
// DEPARTMENT_CATALOGUE_REVALIDATE_SECONDS, un test le vérifie). Les chiffres viennent du cache
// de données d'une heure de `loadDepartmentCatalogue`. Une base indisponible lève une erreur : la
// réponse n'est pas mise en cache, et une version déjà produite reste servie.
export const revalidate = 3600;

// Une lecture complète du catalogue (jusqu'à 100 appels à la base) peut tomber sur ce rendu quand le
// cache de données est vide : la durée est relevée (60 s), sans aller jusqu'au maximum de la
// plateforme. Next.js veut un littéral ici ; il doit rester égal à DEPARTMENT_PAGES_MAX_DURATION_SECONDS
// (un test le vérifie).
export const maxDuration = 60;

export async function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const department = departmentFromSlug((await params).departement);
  if (!department) {
    return { title: "Département introuvable", robots: { index: false, follow: false } };
  }
  const { departments } = await loadDepartmentCatalogue();
  const stats = departments[department.code] ?? null;
  return {
    ...pageMetadata({
      path: department.path,
      title: departmentPageTitle(department),
      description: departmentPageDescription(department, stats),
    }),
    // Moins de trois ventes à venir : page consultable, mais sans intérêt pour un moteur de
    // recherche. Elle reste hors du sitemap (même seuil) et ses liens sont suivis.
    ...(isDepartmentPageIndexable(stats?.upcomingCount ?? 0)
      ? {}
      : { robots: { index: false, follow: true } }),
  };
}

export default async function Page({ params }: PageProps) {
  const department = departmentFromSlug((await params).departement);
  if (!department) notFound();

  const [catalogue, activity] = await Promise.all([
    loadDepartmentCatalogue(),
    loadPublicTribunalActivity(),
  ]);
  const stats = catalogue.departments[department.code] ?? null;
  const tribunals =
    activity.status === "ok"
      ? activity.items.filter(
          (item) => departmentFromCode(item.department)?.code === department.code,
        )
      : [];
  const neighborCounts = Object.fromEntries(
    neighboringDepartmentCodes(department.code).map((code) => [
      code,
      catalogue.departments[code]?.upcomingCount ?? 0,
    ]),
  );
  const origin = resolveSiteOrigin(process.env, "http://localhost:3000")!;
  const itemList = departmentItemListStructuredData(origin, stats?.sales ?? []);

  return (
    <>
      <BreadcrumbJsonLd
        trail={[
          { name: "Ventes aux enchères par département", path: DEPARTMENT_PAGES_PATH },
          { name: department.name, path: department.path },
        ]}
      />
      {itemList ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLdString(itemList) }}
        />
      ) : null}
      <DepartmentView
        department={department}
        stats={stats}
        tribunals={tribunals}
        generatedAt={catalogue.generatedAt}
        neighborCounts={neighborCounts}
      />
    </>
  );
}
