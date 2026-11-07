import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/BreadcrumbJsonLd";
import {
  DepartmentDirectory,
  type DepartmentDirectoryRow,
} from "@/components/departments/DepartmentDirectory";
import { DepartmentFranceMap } from "@/components/departments/DepartmentFranceMap";
import { HighlightedFigure } from "@/components/departments/HighlightedFigure";
import { Card, Eyebrow, buttonClasses } from "@/components/ui/primitives";
import {
  DEPARTMENT_INDEX_TITLE,
  DEPARTMENT_PAGES_PATH,
  DEPARTMENTS,
  departmentSaleCount,
  indexableDepartments,
} from "@/lib/department-pages";
import { DEPARTMENT_REGIONS, departmentRegionName } from "@/lib/department-geography";
import { tryLoadDepartmentCatalogue } from "@/lib/department-pages.server";
import { pageMetadata } from "@/lib/page-metadata";

// Rendue à l'avance (le build n'a pas toujours la base) puis rafraîchie : sans valeur explicite,
// un rendu fait pendant une panne serait gardé jusqu'au prochain déploiement. 5 minutes, comme
// `/tribunaux` ; les chiffres restent en cache de données une heure.
export const revalidate = 300;

// Une lecture complète du catalogue (jusqu'à 100 appels à la base) peut tomber sur ce rendu quand le
// cache de données est vide : la durée est relevée (60 s), sans aller jusqu'au maximum de la
// plateforme. Next.js veut un littéral ici ; il doit rester égal à DEPARTMENT_PAGES_MAX_DURATION_SECONDS
// (un test le vérifie).
export const maxDuration = 60;

const count = new Intl.NumberFormat("fr-FR");

/** Départements présentés dans « Les départements les plus actifs ». */
const TOP_DEPARTMENTS = 10;

export async function generateMetadata(): Promise<Metadata> {
  const result = await tryLoadDepartmentCatalogue();
  return {
    ...pageMetadata({
      path: DEPARTMENT_PAGES_PATH,
      title: DEPARTMENT_INDEX_TITLE,
      description:
        "Les ventes immobilières aux enchères à venir département par département : nombre de ventes, prochaine date de vente et mise à prix médiane des ventes au tribunal, chez le notaire ou par l’État.",
    }),
    // Sans aucune page de département indexable, l'index n'a rien à offrir de propre. Une erreur de
    // lecture ne dit rien des départements : la page reste indexable.
    ...(result.status === "ok" && indexableDepartments(result.catalogue).length === 0
      ? { robots: { index: false, follow: true } }
      : {}),
  };
}

/** « 833 ventes immobilières aux enchères à venir, dans 86 départements. » */
function IndexTitle({ total, active }: { total: number | null; active: number }) {
  if (total == null) return <>{DEPARTMENT_INDEX_TITLE}</>;
  if (total === 0) return <>Aucune vente immobilière aux enchères à venir pour le moment.</>;
  return (
    <>
      <HighlightedFigure>{count.format(total)}</HighlightedFigure>{" "}
      {total > 1 ? "ventes immobilières" : "vente immobilière"} aux enchères à venir, dans{" "}
      <HighlightedFigure>{count.format(active)}</HighlightedFigure>{" "}
      {active > 1 ? "départements" : "département"}.
    </>
  );
}

function TopDepartments({
  departments,
}: {
  departments: ReadonlyArray<{ code: string; name: string; path: string; count: number }>;
}) {
  const max = departments[0]?.count ?? 1;
  return (
    <Card as="section" aria-labelledby="plus-actifs">
      <h2 id="plus-actifs" className="font-display text-xl font-semibold">
        Les départements les plus actifs
      </h2>
      <p className="mt-1 text-sm text-ink-soft">
        Nombre de ventes à venir dans le catalogue public.
      </p>
      <ol className="mt-3.5 grid gap-0.5">
        {departments.map((department, index) => (
          <li key={department.code}>
            <Link
              href={department.path}
              className="grid min-h-11 grid-cols-[1.375rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 rounded-md px-1.5 py-2 hover:bg-surface-muted"
            >
              <span className="text-caption tabular-nums text-ink-soft">{index + 1}</span>
              <span className="min-w-0 font-semibold">
                {department.name}{" "}
                <span className="font-medium text-ink-soft">({department.code})</span>
              </span>
              <span className="font-bold tabular-nums">
                {count.format(department.count)}
                <span className="sr-only">
                  {" "}
                  {department.count > 1 ? "ventes" : "vente"} à venir
                </span>
              </span>
              <span
                aria-hidden
                className="col-start-2 col-end-4 h-1.5 overflow-hidden rounded-full bg-line-soft"
              >
                <span
                  className="block h-full rounded-full bg-brand-navy"
                  style={{ width: `${((department.count / max) * 100).toFixed(1)}%` }}
                />
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export default async function Page() {
  const result = await tryLoadDepartmentCatalogue();
  const catalogue = result.status === "ok" ? result.catalogue : null;
  const counted = DEPARTMENTS.map((department) => ({
    code: department.code,
    name: department.name,
    path: department.path,
    count: catalogue ? departmentSaleCount(catalogue, department.code) : null,
  }));
  const total = catalogue
    ? Object.values(catalogue.departments).reduce((sum, item) => sum + item.upcomingCount, 0)
    : null;
  const active = counted.filter((department) => (department.count ?? 0) > 0).length;
  const rows: DepartmentDirectoryRow[] = counted.map((department) => ({
    ...department,
    region: departmentRegionName(department.code) ?? "Outre-mer",
  }));
  const withCounts = catalogue
    ? counted.map((department) => ({ ...department, count: department.count ?? 0 }))
    : null;
  const top = (withCounts ?? [])
    .filter((department) => department.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "fr"))
    .slice(0, TOP_DEPARTMENTS);

  return (
    <>
      <BreadcrumbJsonLd
        trail={[{ name: "Ventes aux enchères par département", path: DEPARTMENT_PAGES_PATH }]}
      />
      <main id="contenu" className="mx-auto w-full max-w-7xl px-4 pb-12 sm:px-6">
        <section className="pt-6 pb-2 sm:pt-11">
          <Eyebrow>Ventes aux enchères · Par département</Eyebrow>
          <h1 className="mt-3 max-w-[56rem] font-display text-3xl leading-snug font-semibold sm:text-4xl">
            <IndexTitle total={total} active={active} />
          </h1>
          <p className="mt-3 max-w-[41rem] text-base text-ink-soft">
            Au tribunal, chez le notaire et ventes de l’État. Choisissez un département pour voir
            ses ventes, sa prochaine date de vente et la mise à prix médiane des ventes au tribunal.
          </p>
          {catalogue == null ? (
            <p role="status" className="mt-4 text-ink-soft">
              Les chiffres par département sont momentanément indisponibles ; les pages restent
              accessibles.
            </p>
          ) : null}
        </section>

        <DepartmentDirectory
          rows={rows}
          regions={DEPARTMENT_REGIONS.map((region) => region.name)}
          action={
            <Link href="/sales" className={buttonClasses({ variant: "secondary", size: "lg" })}>
              Voir toutes les ventes sur la carte
            </Link>
          }
          searchIcon={
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              className="pointer-events-none absolute top-1/2 left-3.5 size-[18px] -translate-y-1/2 text-ink-soft"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-4-4" />
            </svg>
          }
          overview={
            withCounts && total ? (
              <div className="mt-8 grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
                <Card as="section" aria-labelledby="carte-ventes">
                  <h2 id="carte-ventes" className="font-display text-xl font-semibold">
                    Où se trouvent les ventes
                  </h2>
                  <p className="mt-1 text-sm text-ink-soft">
                    Un rond par département, proportionnel au nombre de ventes à venir.
                  </p>
                  <DepartmentFranceMap departments={withCounts} />
                </Card>
                <TopDepartments departments={top} />
              </div>
            ) : null
          }
        />

        <p className="mt-7 text-sm text-ink-soft">
          Vous préférez chercher par tribunal ?{" "}
          <Link href="/tribunaux" className="font-semibold text-gold-text underline">
            Voir les tribunaux et leur activité
          </Link>
          .
        </p>
      </main>
    </>
  );
}
