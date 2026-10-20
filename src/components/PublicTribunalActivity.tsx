import Link from "next/link";
import { formatPrice } from "@/lib/format";
import { pathWithSearch } from "@/lib/navigation";
import { publicTribunalTotals, type PublicTribunalActivity } from "@/lib/public-tribunal-activity";
import { tribunalPages } from "@/lib/tribunal-pages";

/** Busiest courts shown upfront; the others stay one click away. */
const FIRST_ROWS = 15;

function formatCount(value: number): string {
  return new Intl.NumberFormat("fr-FR").format(value);
}

function formatShortDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "short",
    timeZone: "Europe/Paris",
  }).format(new Date(value));
}

function mix(item: PublicTribunalActivity): string {
  return [
    item.houseCount ? `${item.houseCount} maison${item.houseCount > 1 ? "s" : ""}` : null,
    item.apartmentCount
      ? `${item.apartmentCount} appartement${item.apartmentCount > 1 ? "s" : ""}`
      : null,
    item.otherCount ? `${item.otherCount} autre${item.otherCount > 1 ? "s" : ""}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function Rows({
  items,
  pagePaths,
}: {
  items: PublicTribunalActivity[];
  /** Adresse de la page de chaque tribunal (`/tribunaux/[slug]`), par code. */
  pagePaths: ReadonlyMap<string, string>;
}) {
  return items.map((item) => (
    <tr key={item.code} className="border-t border-brand-navy/10">
      <th scope="row" className="py-3 pr-4 text-left font-semibold">
        <Link
          href={pagePaths.get(item.code) ?? pathWithSearch("/sales", { tribunal: item.searchName })}
          className="underline-offset-4 hover:underline"
        >
          {item.name}
        </Link>
        {item.department ? (
          <span className="ml-1 font-normal text-brand-navy/60">({item.department})</span>
        ) : null}
        <span className="block text-xs font-normal text-brand-navy/60 sm:hidden">
          Audience le {formatShortDate(item.nextSaleDate)} · {mix(item)}
        </span>
      </th>
      {/* Un seul lien par ligne : le nom, vers la page du tribunal (qui renvoie à la recherche). */}
      <td className="py-3 pr-4 text-right tabular-nums">{formatCount(item.upcomingCount)}</td>
      <td className="hidden whitespace-nowrap py-3 pr-4 text-right sm:table-cell">
        {formatShortDate(item.nextSaleDate)}
      </td>
      <td className="whitespace-nowrap py-3 text-right tabular-nums sm:pr-4">
        {item.medianStartingPriceEur != null ? formatPrice(item.medianStartingPriceEur) : "—"}
      </td>
      <td className="hidden py-3 text-sm text-brand-navy/70 sm:table-cell">{mix(item)}</td>
    </tr>
  ));
}

function Table({
  items,
  caption,
  pagePaths,
}: {
  items: PublicTribunalActivity[];
  caption: string;
  pagePaths: ReadonlyMap<string, string>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="text-xs uppercase tracking-[0.08em] text-brand-navy/60">
            <th scope="col" className="pb-2 pr-4 text-left font-semibold">
              Tribunal judiciaire
            </th>
            <th scope="col" className="pb-2 pr-4 text-right font-semibold">
              Ventes à venir
            </th>
            <th scope="col" className="hidden pb-2 pr-4 text-right font-semibold sm:table-cell">
              Prochaine audience
            </th>
            <th scope="col" className="pb-2 text-right font-semibold sm:pr-4">
              Mise à prix médiane
            </th>
            <th scope="col" className="hidden pb-2 text-left font-semibold sm:table-cell">
              Biens
            </th>
          </tr>
        </thead>
        <tbody>
          <Rows items={items} pagePaths={pagePaths} />
        </tbody>
      </table>
    </div>
  );
}

/**
 * Free, public figures of the courts: what the catalogue lists today. The
 * adjudication results (who won, at what price) remain in the Analyse barometer.
 */
export function PublicTribunalActivitySection({
  items,
  adjudicationStatisticsEnabled = false,
}: {
  items: PublicTribunalActivity[];
  /** Only mentions the Analyse adjudication results once they are open. */
  adjudicationStatisticsEnabled?: boolean;
}) {
  if (!items.length) return null;
  const totals = publicTribunalTotals(items);
  const heading = `${formatCount(totals.upcoming)} ${
    totals.upcoming > 1 ? "ventes judiciaires" : "vente judiciaire"
  } à venir dans ${formatCount(totals.tribunals)} ${totals.tribunals > 1 ? "tribunaux" : "tribunal"}`;
  const pagePaths = new Map(tribunalPages(items).map((page) => [page.activity.code, page.path]));
  const first = items.slice(0, FIRST_ROWS);
  const rest = items.slice(FIRST_ROWS);
  return (
    <section
      aria-labelledby="public-tribunal-activity-title"
      className="mb-10 rounded-xl border border-brand-navy/15 bg-white p-5 sm:p-7"
    >
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-gold-text">
        Accès libre · mis à jour chaque heure
      </p>
      <h2
        id="public-tribunal-activity-title"
        className="mt-2 font-display text-2xl font-semibold sm:text-3xl"
      >
        {heading}
      </h2>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-brand-navy/70">
        Le volume d’audiences, la prochaine date et la mise à prix médiane des biens annoncés,
        tribunal par tribunal.
        {adjudicationStatisticsEnabled
          ? " Les prix d’adjudication et les résultats des ventes passées sont réservés à l’offre Analyse."
          : null}{" "}
        Les audiences des prochains jours sont réunies sur{" "}
        <Link href="/audiences-a-venir" className="font-semibold underline">
          la page des audiences à venir
        </Link>
        .
      </p>
      <div className="mt-6">
        <Table
          items={first}
          caption="Tribunaux ayant le plus de ventes à venir"
          pagePaths={pagePaths}
        />
      </div>
      {rest.length ? (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-semibold text-brand-navy">
            Voir les {formatCount(rest.length)} autres tribunaux
          </summary>
          <div className="mt-3">
            <Table
              items={rest}
              caption="Autres tribunaux ayant des ventes à venir"
              pagePaths={pagePaths}
            />
          </div>
        </details>
      ) : null}
    </section>
  );
}
