import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/BreadcrumbJsonLd";
import { Card, PageShell } from "@/components/ui/primitives";
import {
  DEPARTMENT_INDEX_TITLE,
  DEPARTMENT_PAGES_PATH,
  DEPARTMENTS,
  departmentSaleCount,
  indexableDepartments,
  type DepartmentCatalogue,
} from "@/lib/department-pages";
import { tryLoadDepartmentCatalogue } from "@/lib/department-pages.server";
import { pageMetadata } from "@/lib/page-metadata";

// Rendue à l'avance (le build n'a pas toujours la base) puis rafraîchie : sans valeur explicite,
// un rendu fait pendant une panne serait gardé jusqu'au prochain déploiement. 5 minutes, comme
// `/tribunaux` ; les chiffres restent en cache de données une heure.
export const revalidate = 300;

const count = new Intl.NumberFormat("fr-FR");

export async function generateMetadata(): Promise<Metadata> {
  const result = await tryLoadDepartmentCatalogue();
  return {
    ...pageMetadata({
      path: DEPARTMENT_PAGES_PATH,
      title: DEPARTMENT_INDEX_TITLE,
      description:
        "Les ventes immobilières aux enchères à venir département par département : nombre de ventes, prochaine audience et mise à prix médiane, au tribunal, chez le notaire ou par l’État.",
    }),
    // Sans aucune page de département indexable, l'index n'a rien à offrir de propre. Une erreur de
    // lecture ne dit rien des départements : la page reste indexable.
    ...(result.status === "ok" && indexableDepartments(result.catalogue).length === 0
      ? { robots: { index: false, follow: true } }
      : {}),
  };
}

function saleCountLabel(catalogue: DepartmentCatalogue | null, code: string): string | null {
  if (!catalogue) return null;
  const total = departmentSaleCount(catalogue, code);
  if (total === 0) return "Aucune vente à venir";
  return `${count.format(total)} ${total > 1 ? "ventes" : "vente"} à venir`;
}

export default async function Page() {
  const result = await tryLoadDepartmentCatalogue();
  const catalogue = result.status === "ok" ? result.catalogue : null;
  const total = catalogue
    ? Object.values(catalogue.departments).reduce((sum, item) => sum + item.upcomingCount, 0)
    : null;

  return (
    <>
      <BreadcrumbJsonLd
        trail={[{ name: "Ventes aux enchères par département", path: DEPARTMENT_PAGES_PATH }]}
      />
      <PageShell
        eyebrow="Par département"
        title="Ventes aux enchères immobilières par département"
        description={
          total != null
            ? `${count.format(total)} ${total > 1 ? "ventes à venir" : "vente à venir"} dans le catalogue public d’Immojudis. Choisissez un département pour voir ses ventes, sa prochaine audience et la mise à prix médiane.`
            : "Choisissez un département pour voir ses ventes à venir, sa prochaine audience et la mise à prix médiane."
        }
      >
        {catalogue == null ? (
          <p role="status" className="mb-6 text-ink-soft">
            Les chiffres par département sont momentanément indisponibles ; les pages restent
            accessibles.
          </p>
        ) : null}
        <Card as="section" aria-labelledby="departements">
          <h2 id="departements" className="font-display text-2xl font-semibold">
            Tous les départements
          </h2>
          <ul className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            {DEPARTMENTS.map((department) => {
              const label = saleCountLabel(catalogue, department.code);
              return (
                <li key={department.code}>
                  <Link
                    href={department.path}
                    className="flex justify-between gap-3 py-1 hover:underline"
                  >
                    <span className="font-semibold">
                      {department.name}{" "}
                      <span className="font-normal text-ink-soft">({department.code})</span>
                    </span>
                    {label ? <span className="text-sm text-ink-soft">{label}</span> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
        <p className="mt-6 text-sm text-ink-soft">
          Vous préférez chercher par tribunal ?{" "}
          <Link href="/tribunaux" className="font-semibold text-gold-text underline">
            Voir les tribunaux
          </Link>
          .
        </p>
      </PageShell>
    </>
  );
}
