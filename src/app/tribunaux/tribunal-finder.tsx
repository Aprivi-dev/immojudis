"use client";

import { Fragment, useState, type ReactNode } from "react";

/** Une ligne du tableau des tribunaux : rendue par le serveur, avec le texte où chercher. */
export type TribunalFinderRow = {
  code: string;
  /** Nom du tribunal, ville, numéro et nom du département, en clair. */
  search: string;
  /** La ligne `<tr>` rendue par le serveur. */
  row: ReactNode;
};

const count = new Intl.NumberFormat("fr-FR");

/** Minuscules, sans accent ni tiret ni apostrophe : « Saint-Étienne » se trouve avec « saint etienne ». */
function searchable(value: string): string {
  return value
    .toLocaleLowerCase("fr")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[-'’\s]+/g, " ")
    .trim();
}

/**
 * « Trouver un tribunal » sur `/tribunaux` (repasse design n° 34), comme « Trouver un département »
 * sur l'index des départements. Le tableau complet reste rendu par le serveur (référencement, page
 * sans JavaScript) : les tribunaux les plus actifs d'abord, les autres dans un dépliant. Le
 * navigateur n'ajoute que le filtre en direct, sur le nom, la ville ou le département, sans tenir
 * compte des accents ; les résultats tiennent alors dans un seul tableau.
 */
export function TribunalFinder({
  rows,
  firstCount,
  head,
  searchIcon,
}: {
  rows: readonly TribunalFinderRow[];
  /** Lignes montrées d'emblée ; les suivantes sont dans « Voir les N autres tribunaux ». */
  firstCount: number;
  /** En-tête des colonnes (`<thead>`), rendu par le serveur. */
  head: ReactNode;
  /** Icône du champ, rendue par le serveur (rien de plus à envoyer au navigateur). */
  searchIcon?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const needle = searchable(query);
  const matches = needle ? rows.filter((row) => searchable(row.search).includes(needle)) : null;
  const first = rows.slice(0, firstCount);
  const rest = rows.slice(firstCount);

  const table = (items: readonly TribunalFinderRow[], caption: string) => (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        {head}
        <tbody>
          {items.map((item) => (
            <Fragment key={item.code}>{item.row}</Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <form
        role="search"
        aria-label="Trouver un tribunal"
        className="mt-5"
        onSubmit={(event) => event.preventDefault()}
      >
        <label htmlFor="recherche-tribunal" className="relative block sm:max-w-[32.5rem]">
          <span className="sr-only">Trouver un tribunal</span>
          {searchIcon}
          <input
            id="recherche-tribunal"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Ville ou département, par exemple Bobigny ou 93"
            autoComplete="off"
            className="h-[50px] w-full rounded-md border border-field-border bg-white pr-3.5 pl-11 text-base text-foreground placeholder:text-ink-soft focus-visible:border-gold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
          />
        </label>
      </form>

      <p aria-live="polite" className="sr-only">
        {matches
          ? `${count.format(matches.length)} ${matches.length > 1 ? "tribunaux" : "tribunal"}`
          : ""}
      </p>

      {matches ? (
        matches.length > 0 ? (
          <div className="mt-6">
            {table(matches, `Tribunaux correspondant à « ${query.trim()} »`)}
          </div>
        ) : (
          <p className="mt-6 text-ink-soft">Aucun tribunal ne correspond à « {query.trim()} ».</p>
        )
      ) : (
        <>
          <div className="mt-6">{table(first, "Tribunaux ayant le plus de ventes à venir")}</div>
          {rest.length ? (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-semibold text-brand-navy">
                Voir les {count.format(rest.length)} autres tribunaux
              </summary>
              <div className="mt-3">{table(rest, "Autres tribunaux ayant des ventes à venir")}</div>
            </details>
          ) : null}
        </>
      )}
    </>
  );
}
