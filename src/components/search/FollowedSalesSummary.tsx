import Link from "next/link";
import type { ReactNode } from "react";
import { saleDetailPath } from "@/lib/navigation";
import { saleHearingTime } from "@/lib/seo";
import type { FollowedSales } from "./use-followed-sales";

/** Section « Changements récents » de « Mes favoris » (`FavoriteSaleChanges`). */
const FAVORITE_CHANGES_HREF = "/favoris#favorite-changes-title";

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count > 1 ? pluralForm : singular;
}

type Case = {
  key: string;
  href: string;
  value: string;
  /** Libellé complet (écran large). */
  label: string;
  /** Libellé court de la rangée défilante du mobile. */
  shortLabel: string;
  urgent?: boolean;
};

/**
 * « Votre suivi » sous le titre de /sales, pour un abonné de l'offre Analyse : une case par donnée
 * déjà connue du compte, chacune un lien vers l'endroit où la voir en entier.
 *
 * - ventes suivies (« Mes favoris ») ;
 * - ventes suivies qui ont lieu aujourd'hui, seulement s'il y en a (une seule : lien vers sa fiche) ;
 * - changements récents des ventes suivies (30 jours, « Changements récents » de « Mes favoris ») ;
 * - nouvelles ventes des alertes : notifications non lues de la cloche (« Mes alertes »).
 *
 * Une case dont la donnée n'est pas lue (chargement, panne) n'est pas affichée : jamais de chiffre
 * de remplacement. Sur mobile, les cases forment une rangée qui défile ; dès `sm`, un bandeau.
 */
export function FollowedSalesSummary({ followed }: { followed: FollowedSales }) {
  const cases: Case[] = [];
  const { favorites, todaySales, changes, alertNews } = followed;

  if (favorites) {
    cases.push({
      key: "followed",
      href: "/favoris",
      value: favorites.length.toLocaleString("fr-FR"),
      label: plural(favorites.length, "vente suivie", "ventes suivies"),
      shortLabel: plural(favorites.length, "vente suivie", "ventes suivies"),
    });
  }

  if (todaySales.length > 0) {
    const only = todaySales.length === 1 ? todaySales[0] : null;
    const time = only ? saleHearingTime(only.sale.sale_date) : null;
    const place = only?.sale.city?.trim() || null;
    const detail = [place, time].filter(Boolean).join(", ");
    cases.push({
      key: "today",
      href: only ? saleDetailPath(only.saleId) : "/favoris",
      value: todaySales.length.toLocaleString("fr-FR"),
      label: `${plural(todaySales.length, "vente suivie", "ventes suivies")} aujourd’hui${detail ? ` · ${detail}` : ""}`,
      shortLabel: time ? `aujourd’hui, ${time}` : "aujourd’hui",
      urgent: true,
    });
  }

  if (changes) {
    cases.push({
      key: "changes",
      href: FAVORITE_CHANGES_HREF,
      value: changes.length.toLocaleString("fr-FR"),
      label: `${plural(changes.length, "changement récent", "changements récents")} sur vos ventes suivies`,
      shortLabel: plural(changes.length, "changement", "changements"),
    });
  }

  if (alertNews) {
    const value = `${alertNews.saleCount.toLocaleString("fr-FR")}${alertNews.capped ? "+" : ""}`;
    const many = alertNews.capped || alertNews.saleCount > 1;
    const sales = many ? "nouvelles ventes" : "nouvelle vente";
    const alerts =
      alertNews.alertCount > 1
        ? `dans vos ${alertNews.alertCount.toLocaleString("fr-FR")} alertes`
        : alertNews.alertCount === 1
          ? "dans votre alerte"
          : "dans vos alertes";
    cases.push({
      key: "alerts",
      href: "/alertes",
      value,
      label: `${sales} ${alerts}`,
      shortLabel: sales,
    });
  }

  if (cases.length === 0) return null;

  return (
    <nav
      aria-label="Votre suivi"
      data-testid="followed-sales-summary"
      className="-mx-4 mt-5 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] sm:mx-0 sm:grid sm:gap-0 sm:overflow-visible sm:rounded-lg sm:border sm:border-line-soft sm:bg-white sm:px-0 sm:pb-0"
      style={{ gridTemplateColumns: `repeat(${cases.length}, minmax(0, 1fr))` }}
    >
      {cases.map((item) => (
        <SummaryCase key={item.key} item={item} />
      ))}
    </nav>
  );
}

function SummaryCase({ item }: { item: Case }): ReactNode {
  return (
    <Link
      href={item.href}
      prefetch={false}
      className="flex min-h-11 min-w-[8.5rem] shrink-0 flex-col gap-0.5 rounded-lg border border-line-soft bg-white px-4 py-3 text-brand-navy transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-gold-soft sm:min-w-0 sm:rounded-none sm:border-0 sm:border-l sm:first:rounded-l-lg sm:first:border-l-0 sm:last:rounded-r-lg"
    >
      <span
        className={`text-xl font-semibold leading-tight tabular-nums ${item.urgent ? "text-danger" : ""}`}
      >
        {item.value}
      </span>
      <span
        className={`text-caption ${item.urgent ? "font-semibold text-danger" : "text-ink-soft"}`}
      >
        <span className="sm:hidden">{item.shortLabel}</span>
        <span className="hidden sm:inline">{item.label}</span>
      </span>
    </Link>
  );
}
