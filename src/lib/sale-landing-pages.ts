import type { Metadata } from "next";
import {
  DEPARTMENT_PAGE_LISTED_SALES,
  DEPARTMENT_PAGE_MIN_SALES,
  type DepartmentSaleInput,
} from "@/lib/department-pages";
import { pathWithSearch } from "@/lib/navigation";
import { pageMetadata } from "@/lib/page-metadata";
import { salesSearchToUrlRecord, type SalesSearchParams } from "@/lib/search/search-url-state";

/**
 * Pages d'atterrissage par type de bien ou de vente (« maison aux enchères », « enchères
 * notariales »…). Chacune est l'entrée indexable d'un filtre de `/sales` : elle liste les ventes à
 * venir que la recherche publique renvoie pour ce filtre, avec un court guide. Ce module ne contient
 * que les définitions et du calcul pur ; la lecture de la base est dans
 * `sale-landing-pages.server.ts`, les textes dans chaque page.
 */
export type SaleLandingKey = "house" | "apartment" | "notary" | "state";

export type SaleLandingPage = {
  key: SaleLandingKey;
  /** Adresse canonique de la page. */
  path: string;
  /** Libellé d'un lien vers la page, et nom de la page dans le fil d'Ariane. */
  label: string;
  /** Le filtre de `/sales` qui donne les mêmes ventes (mêmes règles de visibilité). */
  search: Pick<SalesSearchParams, "saleType" | "homeTypes">;
};

export const SALE_LANDING_PAGES: Readonly<Record<SaleLandingKey, SaleLandingPage>> = {
  house: {
    key: "house",
    path: "/maison-aux-encheres",
    label: "Maisons aux enchères",
    search: { homeTypes: ["house"] },
  },
  apartment: {
    key: "apartment",
    path: "/appartement-aux-encheres",
    label: "Appartements aux enchères",
    search: { homeTypes: ["apartment"] },
  },
  notary: {
    key: "notary",
    path: "/encheres-notariales",
    label: "Enchères notariales",
    search: { saleType: "notary" },
  },
  // Le filtre « Domaniales » de la recherche : les ventes que la collecte classe comme ventes de
  // l'État (`sale_venue_type = 'state'`) : le site des cessions immobilières de l'État, et une autre
  // source (l'AGRASC par exemple) quand son annonce désigne une vente de l'État
  // (`services/data-pipeline/src/sale_procedure.py`). La recherche publique ne filtre pas par source.
  state: {
    key: "state",
    path: "/ventes-immobilieres-etat",
    label: "Ventes immobilières de l’État",
    search: { saleType: "state" },
  },
};

/** Ordre des liens entre ces pages (pied de page, index des départements, pages elles-mêmes). */
export const SALE_LANDING_KEYS: readonly SaleLandingKey[] = [
  "house",
  "apartment",
  "notary",
  "state",
];

/** Ventes détaillées sur la page, comme sur une page de département ; la recherche liste le reste. */
export const SALE_LANDING_LISTED_SALES = DEPARTMENT_PAGE_LISTED_SALES;

/**
 * Vrai quand la page peut être indexée et figurer au sitemap. Même seuil que les pages de
 * département (`DEPARTMENT_PAGE_MIN_SALES`) : en dessous de trois ventes à venir, une page de liste
 * est mince ; elle reste consultable, en `noindex, follow`.
 */
export function isSaleLandingIndexable(upcomingCount: number): boolean {
  return upcomingCount >= DEPARTMENT_PAGE_MIN_SALES;
}

/** Lien vers la recherche des mêmes ventes (`/sales?homeTypes=house`, `/sales?saleType=notary`). */
export function saleLandingSearchPath(page: Pick<SaleLandingPage, "search">): string {
  return pathWithSearch("/sales", salesSearchToUrlRecord(page.search));
}

/** Ce qu'une page affiche : le total de la recherche publique et les prochaines ventes. */
export type SaleLandingData = {
  /** Date de lecture (ISO), pour dire « au … ». */
  generatedAt: string;
  /** Ventes à venir, reportées comprises : le total que `/sales` affiche pour le même filtre. */
  upcomingCount: number;
  /** Les prochaines ventes, par date croissante (au plus `SALE_LANDING_LISTED_SALES`). */
  sales: DepartmentSaleInput[];
};

/**
 * Métadonnées d'une page : canonique, partage, et `noindex, follow` sous le seuil. `upcomingCount`
 * vaut `null` quand la base n'a pas pu être lue pendant le build : la page, produite sans liste,
 * n'est pas indexée avant sa première régénération réussie.
 */
export function saleLandingMetadata(
  page: Pick<SaleLandingPage, "path">,
  text: { title: string; description: string },
  upcomingCount: number | null,
): Metadata {
  return {
    ...pageMetadata({ path: page.path, ...text }),
    ...(isSaleLandingIndexable(upcomingCount ?? 0)
      ? {}
      : { robots: { index: false, follow: true } }),
  };
}
