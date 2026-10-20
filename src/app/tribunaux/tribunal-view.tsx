import Link from "next/link";
import { Terme } from "@/components/ceiling/Terme";
import { SaleDetailLink } from "@/components/SaleDetailLink";
import { SectorAlertCta } from "@/components/SectorAlertCta";
import { UnderstandBlock, type UnderstandLink } from "@/components/UnderstandBlock";
import { Card, PageShell, buttonClasses } from "@/components/ui/primitives";
import {
  departmentPriceLabel,
  departmentSaleDateText,
  type DepartmentRef,
  type DepartmentSale,
} from "@/lib/department-pages";
import { departmentIn } from "@/lib/department-grammar";
import { formatStartingPrice, propertyTypeLabel } from "@/lib/format";
import { pathWithSearch } from "@/lib/navigation";
import type { PublicTribunalActivity } from "@/lib/public-tribunal-activity";
import { understandingResources } from "@/lib/resource-related";
import { saleHearingTime, seoLongDate, seoSurface } from "@/lib/seo";
import {
  TRIBUNAL_PAGES_PATH,
  atTribunalPhrase,
  hasReadableTribunalName,
  tribunalLongName,
  tribunalPagePath,
  tribunalPlaceName,
} from "@/lib/tribunal-pages";

const count = new Intl.NumberFormat("fr-FR");

function saleWord(total: number): string {
  return total > 1 ? "ventes" : "vente";
}

/**
 * Contenu de la page d'un tribunal. Les chiffres viennent de l'activité publique des tribunaux
 * (le catalogue public seulement) et la liste des ventes de la même source de visibilité ; le texte
 * d'introduction reste générique et factuel, sans conseil.
 */
export function TribunalView({
  tribunal,
  nextAudience,
  sales,
  salesAvailable,
  countMayIncludeDuplicates = false,
  department,
  siblings,
  generatedAt,
}: {
  tribunal: PublicTribunalActivity;
  /** Prochaine audience hors vente reportée (voir `nextAudienceDate`). */
  nextAudience: string | null;
  sales: readonly DepartmentSale[];
  /** Faux quand la liste n'a pas pu être lue : la page garde ses chiffres et renvoie vers la recherche. */
  salesAvailable: boolean;
  /** Vrai quand le total vient de l'activité publique, qui peut compter deux fois une vente à deux sources. */
  countMayIncludeDuplicates?: boolean;
  department: DepartmentRef | null;
  /** Autres tribunaux du département, avec l'adresse de leur page. */
  siblings: readonly { activity: PublicTribunalActivity; path: string }[];
  generatedAt: Date;
}) {
  const total = tribunal.upcomingCount;
  const place = tribunalPlaceName(tribunal.searchName || tribunal.name);
  const longName = tribunalLongName(tribunal);
  const updated = seoLongDate(generatedAt.toISOString());
  const nextDate = seoLongDate(nextAudience);
  // Un tribunal sans nom lisible : la recherche par nom ne le trouverait pas (le « nom » est son code).
  const searchHref = hasReadableTribunalName(tribunal)
    ? pathWithSearch("/sales", { tribunal: tribunal.searchName })
    : "/sales";
  const listed = sales.length;
  const lawyersHref = pathWithSearch("/avocats", { department: department?.code });
  const where = department ? departmentIn(department) : null;

  const nearby: UnderstandLink[] = [
    ...(department && where
      ? [{ href: department.path, label: `Ventes aux enchères ${where}` }]
      : []),
    ...siblings.map(({ activity, path }) => ({
      href: path,
      label: tribunalLongName(activity),
      detail: `(${count.format(activity.upcomingCount)} ${saleWord(activity.upcomingCount)})`,
    })),
  ];
  const types = [
    { label: "Maisons", count: tribunal.houseCount },
    { label: "Appartements", count: tribunal.apartmentCount },
    { label: "Autres biens", count: tribunal.otherCount },
  ].filter((type) => type.count > 0);

  return (
    <PageShell
      eyebrow="Tribunaux judiciaires"
      title={`Ventes judiciaires à venir ${atTribunalPhrase(tribunal)}`}
      description={
        <>
          Cette page rassemble les ventes immobilières aux enchères à venir référencées par
          Immojudis pour le {longName.charAt(0).toLowerCase() + longName.slice(1)}. Les chiffres
          sont calculés sur le catalogue public{updated ? ` au ${updated}` : ""} et peuvent évoluer
          ; seuls le cahier des conditions de vente et les pièces officielles font foi. Ces
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
            <Link href={TRIBUNAL_PAGES_PATH} className="hover:underline">
              Tribunaux
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li aria-current="page">{place}</li>
        </ol>
      </nav>

      <div className="grid gap-5">
        <Card as="section" aria-labelledby="chiffres">
          <h2 id="chiffres" className="font-display text-2xl font-semibold">
            Dans le catalogue Immojudis
          </h2>
          <dl className="mt-4 grid gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-sm text-ink-soft">Ventes à venir</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{count.format(total)}</dd>
            </div>
            <div>
              <dt className="text-sm text-ink-soft">Prochaine audience</dt>
              <dd className="mt-1 text-lg font-semibold">{nextDate ?? "Non connue"}</dd>
            </div>
            <div>
              <dt className="text-sm text-ink-soft">
                <Terme terme="mise-a-prix">Mise à prix médiane</Terme>
              </dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums">
                {tribunal.medianStartingPriceEur != null
                  ? formatStartingPrice(tribunal.medianStartingPriceEur)
                  : "Non communiquée"}
              </dd>
            </div>
          </dl>
          {types.length > 0 ? (
            <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-ink-soft">
              {types.map((type) => (
                <li key={type.label}>
                  {type.label}{" "}
                  <span className="font-semibold tabular-nums text-foreground">
                    {count.format(type.count)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {total === 0 && listed === 0 ? (
            <p className="mt-3 text-sm text-ink-soft">
              Aucune vente à venir n’est référencée pour ce tribunal pour le moment. Cette page
              reste disponible : elle se remplit dès qu’une vente est annoncée.
            </p>
          ) : null}
          {countMayIncludeDuplicates ? (
            <p className="mt-3 text-sm text-ink-soft">
              Le total peut compter une même vente publiée par deux sources.
            </p>
          ) : null}
          {total > 0 && total < 3 ? (
            <p className="mt-3 text-sm text-ink-soft">
              Avec si peu de ventes, la mise à prix médiane n’est qu’un repère très approximatif.
            </p>
          ) : null}
          <div className="mt-5 flex flex-wrap gap-3">
            <Link
              href={total === 0 ? "/sales" : searchHref}
              className={buttonClasses({ variant: "primary", size: "md" })}
            >
              {total === 0
                ? "Chercher d’autres ventes"
                : `Voir ${total > 1 ? `les ${count.format(total)} ventes` : "la vente"} dans la recherche`}
            </Link>
            <Link
              href="/audiences-a-venir"
              className={buttonClasses({ variant: "secondary", size: "md" })}
            >
              Audiences des prochains jours
            </Link>
          </div>
        </Card>

        <Card as="section" aria-labelledby="ventes">
          <h2 id="ventes" className="font-display text-2xl font-semibold">
            {listed > 0 && listed < total
              ? `Les ${count.format(listed)} prochaines ventes`
              : "Les ventes à venir"}
          </h2>
          {listed > 0 ? (
            <ul className="mt-3 divide-y divide-line">
              {sales.map((sale) => {
                const dateText = departmentSaleDateText(sale, {
                  date: seoLongDate(sale.saleDate),
                  time: saleHearingTime(sale.saleDate),
                });
                const surface = seoSurface(sale.surfaceM2);
                return (
                  <li key={sale.id} className="py-3">
                    <SaleDetailLink
                      saleId={sale.id.toLowerCase()}
                      returnTo={tribunalPagePath(tribunal.code)}
                      className="grid gap-1 sm:grid-cols-[1fr_auto] sm:items-baseline sm:gap-4"
                    >
                      <span className="min-w-0">
                        <span className="font-semibold underline-offset-4 hover:underline">
                          {sale.city || "Commune à confirmer"}
                        </span>
                        <span className="block text-sm text-ink-soft">
                          {[
                            propertyTypeLabel(sale.propertyType),
                            surface,
                            dateText,
                            sale.status === "unknown" ? "Statut à confirmer" : null,
                          ]
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
                    </SaleDetailLink>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-3 text-ink-soft">
              {!salesAvailable
                ? "La liste des ventes est momentanément indisponible."
                : total === 0
                  ? "Aucune vente à venir n’est référencée pour ce tribunal pour le moment."
                  : // Les chiffres et la liste viennent de deux lectures, mises à jour séparément : ne pas affirmer qu'il n'y a rien.
                    "Le détail des ventes n’est pas disponible pour le moment."}{" "}
              <Link href={searchHref} className="font-semibold text-gold-text underline">
                Voir les ventes du tribunal dans la recherche
              </Link>
              .
            </p>
          )}
          {listed > 0 && listed < total ? (
            <p className="mt-4 text-sm text-ink-soft">
              Les autres ventes sont dans{" "}
              <Link href={searchHref} className="font-semibold text-gold-text underline">
                la recherche du tribunal
              </Link>
              .
            </p>
          ) : null}
        </Card>

        {department && where ? (
          <SectorAlertCta
            criteria={{ department: department.code }}
            intro={`Les alertes suivent un département, pas un tribunal : celle-ci porte sur les nouvelles ventes référencées ${where}, tous tribunaux confondus.`}
          />
        ) : null}

        <UnderstandBlock
          articles={understandingResources(tribunal.code)}
          nearbyTitle={
            where ? `${where.charAt(0).toUpperCase()}${where.slice(1)}` : "Autres tribunaux"
          }
          nearby={nearby}
        />

        <p className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink-soft">
          <Link href={TRIBUNAL_PAGES_PATH} className="font-semibold text-gold-text underline">
            Tous les tribunaux
          </Link>
          <Link href={lawyersHref} className="font-semibold text-gold-text underline">
            Avocats
          </Link>
        </p>
      </div>
    </PageShell>
  );
}
