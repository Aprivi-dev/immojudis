import Link from "next/link";
import { SectorAlertCta } from "@/components/SectorAlertCta";
import { UnderstandBlock } from "@/components/UnderstandBlock";
import { Card, PageShell, buttonClasses } from "@/components/ui/primitives";
import {
  DEPARTMENT_PAGES_PATH,
  departmentFromCode,
  departmentNextDateLabel,
  departmentPriceLabel,
  departmentSaleDateText,
  departmentSearchPath,
  type DepartmentRef,
  type DepartmentStats,
} from "@/lib/department-pages";
import { neighboringDepartmentCodes } from "@/lib/department-neighbors";
import { formatStartingPrice, propertyTypeLabel } from "@/lib/format";
import { pathWithSearch } from "@/lib/navigation";
import type { PublicTribunalActivity } from "@/lib/public-tribunal-activity";
import { understandingResources } from "@/lib/resource-related";
import { saleHearingTime, seoLongDate, seoSurface } from "@/lib/seo";

const count = new Intl.NumberFormat("fr-FR");

function saleWord(total: number): string {
  return total > 1 ? "ventes" : "vente";
}

/**
 * Contenu d'une page de département. Tous les chiffres viennent du catalogue public à venir
 * (`department-pages.ts`) ; le texte d'introduction reste générique et factuel.
 */
export function DepartmentView({
  department,
  stats,
  tribunals,
  generatedAt,
  neighborCounts = {},
}: {
  department: DepartmentRef;
  stats: DepartmentStats | null;
  tribunals: readonly PublicTribunalActivity[];
  generatedAt: string;
  /** Ventes à venir des départements limitrophes, par code (absent : le catalogue n'a rien à dire). */
  neighborCounts?: Readonly<Record<string, number>>;
}) {
  const total = stats?.upcomingCount ?? 0;
  const now = new Date();
  const nextDate = seoLongDate(stats?.nextSaleDate);
  const updated = seoLongDate(generatedAt);
  const searchHref = departmentSearchPath(department);
  const neighbors = neighboringDepartmentCodes(department.code)
    .map((code) => departmentFromCode(code))
    .filter((neighbor): neighbor is DepartmentRef => neighbor != null)
    .map((neighbor) => {
      const sales = neighborCounts[neighbor.code] ?? 0;
      return {
        href: neighbor.path,
        label: neighbor.name,
        ...(sales > 0 ? { detail: `(${count.format(sales)} ${saleWord(sales)})` } : {}),
      };
    });

  return (
    <PageShell
      eyebrow="Ventes aux enchères par département"
      title={`Ventes aux enchères immobilières : ${department.name} (${department.code})`}
      description={
        <>
          Cette page rassemble les ventes immobilières aux enchères à venir référencées par
          Immojudis dans ce département : ventes au tribunal, chez un notaire ou domaniales. Les
          chiffres sont calculés sur le catalogue public{updated ? ` au ${updated}` : ""} et peuvent
          évoluer ; seuls le cahier des conditions de vente et les pièces officielles font foi. Ces
          informations ne constituent pas un conseil juridique.
        </>
      }
    >
      <nav aria-label="Fil d’Ariane" className="mb-6 text-sm text-ink-soft">
        <ol className="flex flex-wrap items-center gap-x-2">
          <li>
            <Link href="/" className="hover:underline">
              Accueil
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li>
            <Link href={DEPARTMENT_PAGES_PATH} className="hover:underline">
              Ventes par département
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li aria-current="page">{department.name}</li>
        </ol>
      </nav>

      <div className="grid gap-5">
        <Card as="section" aria-labelledby="chiffres">
          <h2 id="chiffres" className="font-display text-2xl font-semibold">
            Les chiffres du département
          </h2>
          {total > 0 ? (
            <dl className="mt-4 grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-sm text-ink-soft">Ventes à venir</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">{count.format(total)}</dd>
              </div>
              <div>
                <dt className="text-sm text-ink-soft">
                  {departmentNextDateLabel(stats?.nextSaleVenueType ?? null)}
                </dt>
                <dd className="mt-1 text-lg font-semibold">{nextDate ?? "Date à confirmer"}</dd>
              </div>
              <div>
                <dt className="text-sm text-ink-soft">Mise à prix médiane (ventes au tribunal)</dt>
                <dd className="mt-1 text-lg font-semibold tabular-nums">
                  {stats?.medianStartingPriceEur != null
                    ? formatStartingPrice(stats.medianStartingPriceEur)
                    : "Non communiquée"}
                </dd>
                {stats?.medianStartingPriceEur != null ? (
                  <dd className="mt-1 text-xs text-ink-soft">
                    sur {count.format(stats.medianSampleSize)} {saleWord(stats.medianSampleSize)} au
                    tribunal ; les autres ventes ne sont pas comptées
                  </dd>
                ) : (
                  <dd className="mt-1 text-xs text-ink-soft">
                    aucune vente au tribunal chiffrée dans ce département
                  </dd>
                )}
              </div>
            </dl>
          ) : (
            <p className="mt-3 text-ink-soft">
              Aucune vente à venir n’est référencée dans ce département pour le moment. Le catalogue
              est mis à jour régulièrement.
            </p>
          )}
          {total > 0 && total < 3 ? (
            <p className="mt-3 text-sm text-ink-soft">
              Avec si peu de ventes, la mise à prix médiane n’est qu’un repère très approximatif.
            </p>
          ) : null}
          <div className="mt-5">
            <Link href={searchHref} className={buttonClasses({ variant: "primary", size: "md" })}>
              Voir {total > 0 ? `les ${count.format(total)} ${saleWord(total)} ` : "la recherche "}
              en {department.name}
            </Link>
          </div>
        </Card>

        <SectorAlertCta
          criteria={{ department: department.code }}
          intro={`Recevez les nouvelles ventes référencées en ${department.name} dès qu’elles sont publiées, dans vos alertes ou, si vous le souhaitez, dans un email récapitulatif.`}
        />

        {stats && stats.types.length > 0 ? (
          <Card as="section" aria-labelledby="types">
            <h2 id="types" className="font-display text-2xl font-semibold">
              Répartition par type de bien
            </h2>
            <ul className="mt-3 grid gap-1 text-ink-soft sm:grid-cols-2">
              {stats.types.map((type) => (
                <li key={type.label} className="flex justify-between gap-3">
                  <span>{type.label}</span>
                  <span className="font-semibold tabular-nums text-foreground">
                    {count.format(type.count)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {stats && stats.sales.length > 0 ? (
          <Card as="section" aria-labelledby="ventes">
            <h2 id="ventes" className="font-display text-2xl font-semibold">
              {stats.sales.length < stats.upcomingCount
                ? `Les ${count.format(stats.sales.length)} prochaines ventes`
                : "Les ventes à venir"}
            </h2>
            <ul className="mt-3 divide-y divide-line">
              {stats.sales.map((sale) => {
                const dateText = departmentSaleDateText(
                  sale,
                  { date: seoLongDate(sale.saleDate), time: saleHearingTime(sale.saleDate) },
                  now,
                );
                const surface = seoSurface(sale.surfaceM2);
                return (
                  <li key={sale.id} className="py-3">
                    <Link
                      href={`/sales/${sale.id.toLowerCase()}`}
                      className="grid gap-1 sm:grid-cols-[1fr_auto] sm:items-baseline sm:gap-4"
                    >
                      <span className="min-w-0">
                        <span className="font-semibold underline-offset-4 hover:underline">
                          {sale.city || "Commune à confirmer"}
                        </span>
                        <span className="block text-sm text-ink-soft">
                          {[propertyTypeLabel(sale.propertyType), surface, dateText]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                      <span className="text-sm tabular-nums">
                        <span className="text-ink-soft">{departmentPriceLabel(sale)} </span>
                        <span className="font-semibold">
                          {formatStartingPrice(sale.startingPriceEur)}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
            {stats.sales.length < stats.upcomingCount ? (
              <p className="mt-4 text-sm text-ink-soft">
                Les autres ventes sont dans{" "}
                <Link href={searchHref} className="font-semibold text-gold-text underline">
                  la recherche du département
                </Link>
                .
              </p>
            ) : null}
          </Card>
        ) : null}

        <Card as="section" aria-labelledby="tribunaux">
          <h2 id="tribunaux" className="font-display text-2xl font-semibold">
            Tribunaux et ventes
          </h2>
          {tribunals.length > 0 ? (
            <>
              <p className="mt-3 text-ink-soft">
                Tribunaux judiciaires de {department.name} ayant des ventes à venir :
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {tribunals.map((tribunal) => (
                  <li key={tribunal.code}>
                    <Link
                      href={pathWithSearch("/sales", { tribunal: tribunal.searchName })}
                      className="font-semibold text-gold-text underline"
                    >
                      {tribunal.name}
                    </Link>{" "}
                    <span className="text-ink-soft">
                      ({count.format(tribunal.upcomingCount)} {saleWord(tribunal.upcomingCount)})
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="mt-3 text-ink-soft">
            Une vente peut dépendre d’un tribunal situé dans un autre département.{" "}
            <Link href="/tribunaux" className="font-semibold text-gold-text underline">
              Voir tous les tribunaux et leur activité
            </Link>
            .
          </p>
        </Card>

        <UnderstandBlock
          articles={understandingResources(department.code)}
          nearbyTitle="Départements limitrophes"
          nearby={neighbors}
        />

        <p className="text-sm text-ink-soft">
          <Link href={DEPARTMENT_PAGES_PATH} className="font-semibold text-gold-text underline">
            Tous les départements
          </Link>
        </p>
      </div>
    </PageShell>
  );
}
