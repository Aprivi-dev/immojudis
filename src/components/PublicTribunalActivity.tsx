import Link from "next/link";
import { TribunalFinder, type TribunalFinderRow } from "@/app/tribunaux/tribunal-finder";
import { departmentFromCode } from "@/lib/department-pages";
import { formatPrice } from "@/lib/format";
import { pathWithSearch } from "@/lib/navigation";
import {
  publicTribunalTotals,
  tribunalPriceFigure,
  tribunalSampleLabel,
  type PublicTribunalActivity,
  type TribunalPriceFigure,
} from "@/lib/public-tribunal-activity";
import { tribunalPages } from "@/lib/tribunal-pages";

/** Busiest courts shown upfront; the others stay one click away. */
const FIRST_ROWS = 15;

/** Comment lire la colonne « Mise à prix » (seuils de `tribunalPriceFigure`). */
const PRICE_RULE =
  "La mise à prix n’est publiée qu’avec assez de ventes chiffrées : « — » sous 5, la fourchette observée (minimum et maximum) de 5 à 9, la médiane à partir de 10.";

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

/** La mise à prix d'un tribunal : « — » sous 5 ventes chiffrées, fourchette de 5 à 9, médiane dès 10. */
function PriceCell({ figure }: { figure: TribunalPriceFigure }) {
  if (figure.kind === "median") return <>{formatPrice(figure.median)}</>;
  if (figure.kind === "range") {
    return (
      <>
        {formatPrice(figure.min)} – {formatPrice(figure.max)}
        <span className="block text-xs font-normal text-ink-soft">fourchette observée</span>
      </>
    );
  }
  return (
    <>
      <span aria-label="Non publiée">—</span>
      <span className="block text-xs font-normal text-ink-soft sm:hidden">
        {tribunalSampleLabel(figure.sampleSize)}
      </span>
    </>
  );
}

/**
 * Les lignes du tableau, rendues ici (serveur) : le filtre « Trouver un tribunal » ne fait que les
 * choisir. `search` réunit le nom, la ville, le numéro et le nom du département.
 */
function finderRows(
  items: PublicTribunalActivity[],
  /** Adresse de la page de chaque tribunal (`/tribunaux/[slug]`), par code. */
  pagePaths: ReadonlyMap<string, string>,
): TribunalFinderRow[] {
  return items.map((item) => ({
    code: item.code,
    search: [
      item.name,
      item.searchName,
      item.city,
      item.department,
      departmentFromCode(item.department)?.name,
    ]
      .filter(Boolean)
      .join(" "),
    row: <Row item={item} pagePaths={pagePaths} />,
  }));
}

function Row({
  item,
  pagePaths,
}: {
  item: PublicTribunalActivity;
  pagePaths: ReadonlyMap<string, string>;
}) {
  const figure = tribunalPriceFigure(item);
  return (
    <tr className="border-t border-brand-navy/10">
      <th scope="row" className="py-3 pr-4 text-left font-semibold">
        <Link
          href={pagePaths.get(item.code) ?? pathWithSearch("/sales", { tribunal: item.searchName })}
          className="underline-offset-4 hover:underline"
        >
          {item.name}
        </Link>
        {item.department ? (
          <span className="ml-1 font-normal text-ink-soft">({item.department})</span>
        ) : null}
        <span className="block text-xs font-normal text-ink-soft sm:hidden">
          Audience le {formatShortDate(item.nextSaleDate)} · {mix(item)}
        </span>
      </th>
      {/* Un seul lien par ligne : le nom, vers la page du tribunal (qui renvoie à la recherche). */}
      <td className="py-3 pr-4 text-right tabular-nums">{formatCount(item.upcomingCount)}</td>
      <td className="hidden whitespace-nowrap py-3 pr-4 text-right sm:table-cell">
        {formatShortDate(item.nextSaleDate)}
      </td>
      <td className="hidden py-3 pr-4 text-right tabular-nums sm:table-cell">
        {formatCount(figure.sampleSize)}
      </td>
      <td className="whitespace-nowrap py-3 text-right tabular-nums sm:pr-4">
        <PriceCell figure={figure} />
      </td>
      <td className="hidden py-3 text-sm text-ink-soft sm:table-cell">{mix(item)}</td>
    </tr>
  );
}

/** En-tête des colonnes, commun aux tableaux du filtre. */
function Head() {
  return (
    <thead>
      <tr className="text-xs uppercase tracking-[0.08em] text-ink-soft">
        <th scope="col" className="pb-2 pr-4 text-left font-semibold">
          Tribunal judiciaire
        </th>
        <th scope="col" className="pb-2 pr-4 text-right font-semibold">
          Ventes à venir
        </th>
        <th scope="col" className="hidden pb-2 pr-4 text-right font-semibold sm:table-cell">
          Prochaine audience
        </th>
        <th scope="col" className="hidden pb-2 pr-4 text-right font-semibold sm:table-cell">
          Ventes chiffrées (n)
        </th>
        <th scope="col" className="pb-2 text-right font-semibold sm:pr-4">
          Mise à prix
        </th>
        <th scope="col" className="hidden pb-2 text-left font-semibold sm:table-cell">
          Biens
        </th>
      </tr>
    </thead>
  );
}

/**
 * Free, public figures of the courts: what the catalogue lists today. The
 * adjudication results (who won, at what price) remain in the Analyse barometer.
 */
export function PublicTribunalActivitySection({
  items,
  adjudicationStatisticsEnabled = false,
  ambiguousCodes,
}: {
  items: PublicTribunalActivity[];
  /** Tribunaux sans adresse lisible (homonymes du référentiel complet) : `loadAmbiguousTribunalCodes`. */
  ambiguousCodes?: ReadonlySet<string>;
  /** Only mentions the Analyse adjudication results once they are open. */
  adjudicationStatisticsEnabled?: boolean;
}) {
  if (!items.length) return null;
  const totals = publicTribunalTotals(items);
  const heading = `${formatCount(totals.upcoming)} ${
    totals.upcoming > 1 ? "ventes judiciaires" : "vente judiciaire"
  } à venir dans ${formatCount(totals.tribunals)} ${totals.tribunals > 1 ? "tribunaux" : "tribunal"}`;
  const pagePaths = new Map(
    tribunalPages(items, ambiguousCodes).map((page) => [page.activity.code, page.path]),
  );
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
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-soft">
        Le volume d’audiences, la prochaine date et la mise à prix des biens annoncés, tribunal par
        tribunal.
        {adjudicationStatisticsEnabled
          ? " Les prix d’adjudication et les résultats des ventes passées sont réservés à l’offre Analyse."
          : null}{" "}
        Les audiences des prochains jours sont réunies sur{" "}
        <Link href="/audiences-a-venir" className="font-semibold underline">
          la page des audiences à venir
        </Link>
        .
      </p>
      {/* La règle de lecture : en clair sur ordinateur, dans un dépliant sur mobile (n° 44). */}
      <p className="mt-2 hidden max-w-3xl text-sm leading-relaxed text-ink-soft sm:block">
        {PRICE_RULE}
      </p>
      <details className="mt-2 text-sm sm:hidden">
        <summary className="cursor-pointer py-3 font-semibold text-brand-navy underline underline-offset-2">
          Comment lire la mise à prix
        </summary>
        <p className="mt-1 leading-relaxed text-ink-soft">{PRICE_RULE}</p>
      </details>
      <TribunalFinder rows={finderRows(items, pagePaths)} firstCount={FIRST_ROWS} head={<Head />} />
    </section>
  );
}
