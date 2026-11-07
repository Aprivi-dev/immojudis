import type { ReactNode } from "react";
import Link from "next/link";
import { HighlightedFigure } from "@/components/departments/HighlightedFigure";
import { ProportionalBars } from "@/components/departments/ProportionalBars";
import { SectorAlertCta } from "@/components/SectorAlertCta";
import { Badge, Card, Eyebrow, buttonClasses } from "@/components/ui/primitives";
import {
  DEPARTMENT_PAGES_PATH,
  departmentFromCode,
  departmentNextDateLabel,
  departmentPriceLabel,
  departmentSaleTimeText,
  departmentSearchPath,
  departmentVenueLabel,
  groupDepartmentSalesByWeek,
  identicalSaleRanks,
  isParisToday,
  parisDateBlock,
  parisWeekday,
  type DepartmentRef,
  type DepartmentSale,
  type DepartmentStats,
} from "@/lib/department-pages";
import { departmentRegionName } from "@/lib/department-geography";
import { neighboringDepartmentCodes } from "@/lib/department-neighbors";
import { departmentIn } from "@/lib/department-grammar";
import { formatStartingPrice, propertyTypeLabel } from "@/lib/format";
import { pathWithSearch } from "@/lib/navigation";
import type { PublicTribunalActivity } from "@/lib/public-tribunal-activity";
import { EXISTING_GUIDE } from "@/lib/resource-articles";
import { understandingResources } from "@/lib/resource-related";
import { saleHearingTime, seoLongDate, seoSurface } from "@/lib/seo";
import { hasReadableTribunalName, tribunalPagePath } from "@/lib/tribunal-pages";
import { cn } from "@/lib/utils";

const count = new Intl.NumberFormat("fr-FR");

/**
 * L'alerte de secteur en encart marine (proposition faite à un visiteur) : fond et filet marine,
 * titre plus petit, icône et textes clairs, bouton blanc pleine largeur. Classes posées ici, côté
 * serveur, pour ne rien ajouter au JavaScript de `SectorAlertCta`, copié dans plusieurs pages.
 */
const NAVY_ALERT =
  "border-brand-navy bg-brand-navy text-white [&_a]:w-full [&_a]:bg-white [&_a]:text-center [&_a]:text-brand-navy [&_h2]:text-xl [&_h2_svg]:shrink-0 [&_h2_svg]:text-gold-light [&_p]:text-line-soft";

function saleWord(total: number): string {
  return total > 1 ? "ventes" : "vente";
}

function positivePrice(value: number | null): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

/** Une ligne de « Les prochaines ventes » : pavé de date, commune, détails, type de vente, prix. */
function SaleRow({
  sale,
  identical,
  now,
}: {
  sale: DepartmentSale;
  identical: { rank: number; of: number } | undefined;
  now: Date;
}) {
  const postponed = sale.status === "postponed";
  const block = postponed ? null : parisDateBlock(sale.saleDate);
  const today = !postponed && isParisToday(sale.saleDate, now);
  const venue = departmentVenueLabel(sale.venueType);
  const details = [
    propertyTypeLabel(sale.propertyType),
    seoSurface(sale.surfaceM2),
    departmentSaleTimeText(sale, saleHearingTime(sale.saleDate), now),
    identical ? `annonce ${identical.rank} sur ${identical.of} de même description` : null,
  ].filter(Boolean);
  return (
    <li>
      <Link
        href={`/sales/${sale.id.toLowerCase()}`}
        className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 px-3.5 py-3 hover:bg-surface-muted sm:grid-cols-[4rem_minmax(0,1fr)_auto] sm:px-[1.125rem] sm:py-3.5"
      >
        <span
          className={cn(
            "flex size-14 flex-col items-center justify-center rounded-lg leading-tight sm:size-16",
            today ? "bg-brand-navy text-white" : "bg-surface-tint",
          )}
        >
          {block ? (
            <>
              <span className="text-[1.375rem] font-bold tabular-nums">{block.day}</span>
              <span
                className={cn(
                  "text-xs font-semibold tracking-[0.06em] uppercase",
                  today ? "text-gold-light" : "text-ink-strong",
                )}
              >
                {block.month}
              </span>
            </>
          ) : (
            <span aria-hidden className="text-[1.375rem] font-bold text-ink-soft">
              –
            </span>
          )}
        </span>
        <span className="min-w-0">
          <span className="block font-semibold">{sale.city || "Commune à confirmer"}</span>
          <span className="mt-0.5 block text-sm text-ink-soft">{details.join(" · ")}</span>
          {venue || today ? (
            <span className="mt-2 flex flex-wrap gap-1.5">
              {venue ? <Badge>{venue}</Badge> : null}
              {today ? <Badge tone="danger">Aujourd’hui</Badge> : null}
            </span>
          ) : null}
        </span>
        <span className="col-start-2 flex flex-wrap items-baseline gap-x-1.5 sm:col-start-auto sm:block sm:text-right">
          <span className="text-xs text-ink-soft sm:block">{departmentPriceLabel(sale)}</span>
          {positivePrice(sale.startingPriceEur) ? (
            <span className="text-lg font-semibold whitespace-nowrap text-brand-navy tabular-nums sm:block">
              {formatStartingPrice(sale.startingPriceEur)}
            </span>
          ) : (
            <span className="text-sm font-semibold text-ink-soft sm:block">Non communiqué</span>
          )}
        </span>
      </Link>
    </li>
  );
}

function SidePanel({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <Card as="section" aria-labelledby={id}>
      <h2 id={id} className="text-lg font-bold">
        {title}
      </h2>
      {children}
    </Card>
  );
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
  const sales = stats?.sales ?? [];
  const identicalSales = identicalSaleRanks(sales);
  const weeks = groupDepartmentSalesByWeek(sales, now);
  const cities = stats?.cities ?? [];
  const nextDate = seoLongDate(stats?.nextSaleDate);
  const nextTime = saleHearingTime(stats?.nextSaleDate);
  const nextDay = stats?.nextSaleDate
    ? isParisToday(stats.nextSaleDate, now)
      ? "aujourd’hui"
      : parisWeekday(stats.nextSaleDate)
    : null;
  const updated = seoLongDate(generatedAt);
  const searchHref = departmentSearchPath(department);
  const where = departmentIn(department);
  const region = departmentRegionName(department.code);
  const neighbors = neighboringDepartmentCodes(department.code)
    .map((code) => departmentFromCode(code))
    .filter((neighbor): neighbor is DepartmentRef => neighbor != null);

  return (
    <main id="contenu" className="mx-auto w-full max-w-7xl px-4 pb-12 sm:px-6">
      <nav aria-label="Fil d’Ariane" className="pt-5 text-caption text-ink-soft">
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <li>
            <Link href="/" className="underline-offset-2 hover:underline">
              Accueil
            </Link>
          </li>
          <li aria-hidden>›</li>
          <li>
            <Link href={DEPARTMENT_PAGES_PATH} className="underline-offset-2 hover:underline">
              Ventes par département
            </Link>
          </li>
          <li aria-hidden>›</li>
          <li aria-current="page">{department.name}</li>
        </ol>
      </nav>

      <header className="pt-5 pb-2">
        <Eyebrow>Ventes aux enchères{region ? ` · ${region}` : ""}</Eyebrow>
        <h1 className="mt-3 max-w-[56rem] font-display text-3xl leading-snug font-semibold sm:text-4xl">
          {total > 0 ? (
            <>
              <HighlightedFigure>{count.format(total)}</HighlightedFigure>{" "}
              {total > 1 ? "ventes immobilières" : "vente immobilière"} aux enchères à venir {where}{" "}
              ({department.code}).
            </>
          ) : (
            <>
              Aucune vente immobilière aux enchères à venir {where} ({department.code}) pour le
              moment.
            </>
          )}
        </h1>
        <p className="mt-3 max-w-[41rem] text-base text-ink-soft">
          Au tribunal, chez le notaire et ventes de l’État, d’après le catalogue public
          {updated ? ` au ${updated}` : ""}. Seuls le cahier des conditions de vente et les pièces
          officielles font foi.
        </p>

        {total > 0 ? (
          <section aria-label="Les chiffres du département" className="mt-6">
            <dl className="grid gap-3 sm:grid-cols-3">
              <Card>
                <dt className="text-caption text-ink-soft">Ventes à venir</dt>
                <dd className="mt-1 text-[1.75rem] font-semibold text-brand-navy tabular-nums">
                  {count.format(total)}
                </dd>
                {updated ? (
                  <dd className="mt-0.5 text-caption text-ink-soft">au {updated}</dd>
                ) : null}
              </Card>
              <Card>
                <dt className="text-caption text-ink-soft">
                  {departmentNextDateLabel(stats?.nextSaleVenueType ?? null)}
                </dt>
                <dd className="mt-1 text-[1.75rem] font-semibold text-brand-navy">
                  {nextDate ?? "Date à confirmer"}
                </dd>
                {nextDay ? (
                  <dd className="mt-0.5 text-caption text-ink-soft">
                    {nextDay}
                    {nextTime ? `, à ${nextTime}` : ""}
                  </dd>
                ) : null}
              </Card>
              <Card>
                <dt className="text-caption text-ink-soft">Mise à prix médiane au tribunal</dt>
                <dd className="mt-1 text-[1.75rem] font-semibold text-brand-navy tabular-nums">
                  {stats?.medianStartingPriceEur != null
                    ? formatStartingPrice(stats.medianStartingPriceEur)
                    : "Non communiquée"}
                </dd>
                <dd className="mt-0.5 text-caption text-ink-soft">
                  {stats?.medianStartingPriceEur != null
                    ? `sur ${count.format(stats.medianSampleSize)} ${saleWord(stats.medianSampleSize)} au tribunal`
                    : "aucune vente au tribunal chiffrée"}
                </dd>
              </Card>
            </dl>
            {total < 3 ? (
              <p className="mt-3 text-sm text-ink-soft">
                Avec si peu de ventes, la mise à prix médiane n’est qu’un repère très approximatif.
              </p>
            ) : null}
          </section>
        ) : null}

        <div className="mt-[1.125rem] flex flex-wrap gap-2">
          <Link href={searchHref} className={buttonClasses({ variant: "dark", size: "lg" })}>
            {total > 1
              ? `Voir les ${count.format(total)} ventes sur la carte`
              : total === 1
                ? "Voir la vente sur la carte"
                : "Voir la carte des ventes"}
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              className="size-[18px]"
            >
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </Link>
          <a href="#alerte" className={buttonClasses({ variant: "secondary", size: "lg" })}>
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              className="size-[18px]"
            >
              <path d="M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15z" />
              <path d="M10 20.5a2 2 0 0 0 4 0" />
            </svg>
            Être prévenu des nouvelles ventes
          </a>
        </div>
      </header>

      <div className="mt-9 grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_22.5rem]">
        <div className="min-w-0">
          <section aria-labelledby="ventes">
            <h2 id="ventes" className="font-display text-2xl font-semibold">
              Les prochaines ventes
            </h2>
            {sales.length > 0 ? (
              <>
                {weeks.map((week) => (
                  <div key={week.key} className="mt-5">
                    <h3 className="mb-2 text-caption font-bold tracking-[0.12em] text-gold-text uppercase">
                      {week.label}
                    </h3>
                    <ul className="divide-y divide-line-soft rounded-lg border border-line-soft bg-white">
                      {week.sales.map((sale) => (
                        <SaleRow
                          key={sale.id}
                          sale={sale}
                          identical={identicalSales.get(sale.id)}
                          now={now}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
                {sales.length < total ? (
                  <p className="mt-4 text-sm text-ink-soft">
                    Les {count.format(sales.length)} prochaines ventes sont listées ici ; les autres
                    sont dans{" "}
                    <Link href={searchHref} className="font-semibold text-gold-text underline">
                      la recherche du département
                    </Link>
                    .
                  </p>
                ) : null}
                <div className="mt-4">
                  <Link
                    href={searchHref}
                    className={buttonClasses({ variant: "secondary", size: "lg" })}
                  >
                    Voir {total > 1 ? `les ${count.format(total)} ventes` : "la vente"} {where}
                  </Link>
                </div>
              </>
            ) : (
              <Card className="mt-4">
                <p className="text-ink-soft">
                  Aucune vente à venir n’est référencée dans ce département pour le moment. Le
                  catalogue est mis à jour régulièrement.
                </p>
                <Link
                  href={searchHref}
                  className={cn(buttonClasses({ variant: "secondary" }), "mt-3")}
                >
                  Voir la recherche {where}
                </Link>
              </Card>
            )}
          </section>

          <section aria-labelledby="tribunaux" className="mt-11">
            <h2 id="tribunaux" className="font-display text-xl font-semibold">
              Tribunaux et ventes
            </h2>
            {tribunals.length > 0 ? (
              <ul className="mt-3 divide-y divide-line-soft rounded-lg border border-line-soft bg-white">
                {tribunals.map((tribunal) => (
                  <li
                    key={tribunal.code}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-3.5 py-3 sm:px-[1.125rem] sm:py-3.5"
                  >
                    <Link
                      href={tribunalPagePath(tribunal.code, tribunal)}
                      className="min-w-0 font-semibold underline-offset-4 hover:underline"
                    >
                      {tribunal.name}
                    </Link>
                    <span className="text-right">
                      <span className="block font-semibold text-brand-navy tabular-nums">
                        {count.format(tribunal.upcomingCount)} {saleWord(tribunal.upcomingCount)}
                      </span>
                      {hasReadableTribunalName(tribunal) ? (
                        <Link
                          href={pathWithSearch("/sales", { tribunal: tribunal.searchName })}
                          className="text-xs text-gold-text underline"
                        >
                          voir dans la recherche
                        </Link>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="mt-3 text-sm text-ink-soft">
              Une vente peut dépendre d’un tribunal situé dans un autre département.{" "}
              <Link href="/tribunaux" className="font-semibold text-gold-text underline">
                Voir tous les tribunaux et leur activité
              </Link>
              .
            </p>
          </section>

          <section aria-labelledby="comprendre" className="mt-11">
            <h2 id="comprendre" className="font-display text-xl font-semibold">
              Pour comprendre
            </h2>
            <ul className="mt-3 divide-y divide-line-soft">
              {[EXISTING_GUIDE, ...understandingResources(department.code)].map((article) => (
                <li key={article.slug} className="py-2.5">
                  <Link href={article.href} className="font-semibold text-gold-text underline">
                    {article.slug === EXISTING_GUIDE.slug
                      ? "Le guide des ventes immobilières judiciaires"
                      : article.title}
                  </Link>
                  <span className="block text-caption text-ink-soft">
                    {article.readingMinutes} min de lecture
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <p className="mt-5 max-w-[45rem] text-xs leading-relaxed text-ink-soft">
            Chiffres calculés sur le catalogue public{updated ? ` au ${updated}` : ""} ; ils peuvent
            évoluer. La mise à prix médiane ne compte que les ventes au tribunal. Ces informations
            ne constituent pas un conseil juridique.
          </p>
        </div>

        <aside aria-label="En un coup d’œil" className="grid gap-3 lg:sticky lg:top-24">
          <div id="alerte" className="scroll-mt-24">
            <SectorAlertCta
              title={`Être prévenu des nouvelles ventes ${where}`}
              criteria={{ department: department.code }}
              className={NAVY_ALERT}
              intro={`Recevez les nouvelles ventes référencées ${where} dès qu’elles sont publiées, dans vos alertes ou, si vous le souhaitez, dans un email récapitulatif.`}
            />
          </div>

          {stats && stats.types.length > 0 ? (
            <SidePanel id="types" title="Types de bien">
              <ProportionalBars
                unit={saleWord}
                items={stats.types.map((type) => ({
                  key: type.label,
                  label: type.label,
                  count: type.count,
                }))}
              />
            </SidePanel>
          ) : null}

          {cities.length > 1 ? (
            <SidePanel id="communes" title="Communes les plus présentes">
              <ProportionalBars
                unit={saleWord}
                items={cities.map((entry) => ({
                  key: entry.city,
                  count: entry.count,
                  label: (
                    <Link
                      href={pathWithSearch("/sales", {
                        department: department.code,
                        city: entry.city,
                      })}
                      className="font-semibold text-gold-text underline"
                    >
                      {entry.city}
                    </Link>
                  ),
                }))}
              />
              <p className="mt-2.5 text-xs text-ink-soft">
                Les nombres sont indicatifs : la recherche d’une commune peut afficher d’autres
                ventes dont le nom lui ressemble.
              </p>
            </SidePanel>
          ) : null}

          <SidePanel
            id="limitrophes"
            title={neighbors.length ? "Départements limitrophes" : "Autres départements"}
          >
            {neighbors.length ? (
              <ul className="mt-3 flex flex-wrap gap-2">
                {neighbors.map((neighbor) => {
                  const sales = neighborCounts[neighbor.code] ?? 0;
                  return (
                    <li key={neighbor.code}>
                      <Link
                        href={neighbor.path}
                        className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line bg-white px-3.5 text-sm font-semibold hover:border-brand-navy"
                      >
                        {neighbor.name}
                        <span className="font-medium text-ink-soft tabular-nums">
                          {count.format(sales)}
                          <span className="sr-only"> {saleWord(sales)} à venir</span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <p className="mt-3.5 text-sm">
              <Link href={DEPARTMENT_PAGES_PATH} className="font-semibold text-gold-text underline">
                Tous les départements
              </Link>
            </p>
          </SidePanel>
        </aside>
      </div>
    </main>
  );
}
