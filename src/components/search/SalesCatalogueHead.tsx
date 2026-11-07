import type { ReactNode } from "react";
import { departmentFromCode } from "@/lib/department-pages";
import type { SalesSearchParams } from "@/lib/search/search-url-state";

const FRANCE = "France entière";

/**
 * Zone de la recherche, telle que le surtitre et le titre la nomment : la ville, le département par
 * son nom (« Bouches-du-Rhône (13) », pas « 13 »), la saisie libre, sinon la France entière.
 */
export function catalogueZone(search: SalesSearchParams): {
  /** Surtitre : « Catalogue · <label> ». */
  label: string;
  /** Complément du titre (« à Pau », « dans le département Gironde (33) »), vide pour la France. */
  phrase: string;
} {
  const department = search.city ? null : departmentFromCode(search.department);
  const departmentName = department ? `${department.name} (${department.code})` : null;
  const location = search.city || departmentName || search.department || search.query || FRANCE;
  const phrase =
    location === FRANCE
      ? ""
      : departmentName
        ? ` dans le département ${departmentName}`
        : ` à ${location}`;
  // La carte borne la recherche : le surtitre le dit, le titre garde le lieu choisi.
  return { label: search.viewport ? "Zone choisie sur la carte" : location, phrase };
}

function Figure({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-sm bg-brand-navy px-[0.3em] font-semibold text-white tabular-nums [box-decoration-break:clone] [-webkit-box-decoration-break:clone]">
      {children}
    </span>
  );
}

/**
 * Titre de /sales, en phrase : « 833 ventes immobilières aux enchères à venir, dont 41 cette
 * semaine. » Les chiffres sont des données : le total de la recherche (le compteur de la liste)
 * et le comptage des sept prochains jours (`upcomingWeekScope`). Sans total connu (chargement,
 * panne), le titre reste une phrase sans chiffre ; sans comptage de la semaine (ou zéro), il
 * s'arrête au total. Jamais de chiffre de remplacement.
 *
 * Sur mobile, « immobilières » est retiré de la phrase (titre de quatre lignes sinon).
 */
export function CatalogueTitle({
  search,
  total,
  week,
}: {
  search: SalesSearchParams;
  total: number | null;
  week: number | null;
}) {
  const { phrase } = catalogueZone(search);
  if (total == null) {
    return <>Ventes immobilières aux enchères{phrase}</>;
  }
  const one = total === 1;
  const lead =
    total === 0 ? (
      <>
        Aucune vente<span className="hidden sm:inline"> immobilière</span> aux enchères à venir
      </>
    ) : (
      <>
        <Figure>{total.toLocaleString("fr-FR")}</Figure> {one ? "vente" : "ventes"}
        <span className="hidden sm:inline">{one ? " immobilière" : " immobilières"}</span> aux
        enchères à venir
      </>
    );
  const showWeek = total > 0 && week != null && week > 0 && week <= total;
  return (
    <>
      {lead}
      {phrase}
      {showWeek ? (
        <>
          , dont <Figure>{week.toLocaleString("fr-FR")}</Figure> cette semaine
        </>
      ) : null}
      .
    </>
  );
}

/**
 * En-tête du catalogue (maquette /sales validée) : surtitre de la zone, titre en phrase, chapô
 * court pour qui n'a pas l'offre Analyse ou bandeau « Votre suivi » pour un abonné, et à droite
 * les actions de la recherche (export CSV, alerte), avec leurs droits inchangés.
 */
export function SalesCatalogueHead({
  search,
  total,
  week,
  lede = false,
  followed,
  actions,
}: {
  search: SalesSearchParams;
  total: number | null;
  week: number | null;
  /** Chapô court (visiteur et offre Découverte). */
  lede?: boolean;
  /** Bandeau « Votre suivi » (offre Analyse). */
  followed?: ReactNode;
  actions?: ReactNode;
}) {
  const { label } = catalogueZone(search);
  return (
    <div className="mx-auto flex max-w-[90rem] flex-wrap items-end justify-between gap-x-6 gap-y-4 px-4 pb-4 pt-6 sm:pt-8 lg:px-6 lg:pt-10">
      <div className="min-w-0 flex-[1_1_36rem]">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-gold-text">
          Catalogue · {label}
        </p>
        <h1 className="mt-2 max-w-[58rem] font-display text-[1.65rem] font-medium leading-snug text-balance text-brand-navy sm:text-[2.125rem] lg:text-[2.5rem]">
          <CatalogueTitle search={search} total={total} week={week} />
        </h1>
        {lede ? (
          <p className="mt-3 hidden max-w-[40rem] text-ink-soft sm:block">
            Au tribunal, chez le notaire et ventes de l’État, réunies au même endroit, avec leur
            position sur la carte.
          </p>
        ) : null}
        {followed}
      </div>
      {actions ? <div className="hidden flex-wrap gap-2 lg:flex">{actions}</div> : null}
    </div>
  );
}
