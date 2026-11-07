"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { searchableText as searchable } from "@/lib/searchable-text";

export type DepartmentDirectoryRow = {
  code: string;
  name: string;
  path: string;
  region: string;
  /** Ventes à venir ; `null` quand le catalogue est indisponible (aucun chiffre affiché). */
  count: number | null;
};

type SortMode = "region" | "count" | "alpha";

const SORT_LABELS: Record<SortMode, string> = {
  region: "Par région",
  count: "Par nombre de ventes",
  alpha: "De A à Z",
};

const numbers = new Intl.NumberFormat("fr-FR");

function salesPhrase(total: number): string {
  if (total === 0) return "aucune vente à venir";
  return `${numbers.format(total)} ${total > 1 ? "ventes" : "vente"} à venir`;
}

function DepartmentRow({ row, maxCount }: { row: DepartmentDirectoryRow; maxCount: number }) {
  const empty = row.count === 0;
  return (
    <li>
      <Link
        href={row.path}
        className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-md px-2 py-2 hover:bg-surface-muted"
      >
        <span className={cn("min-w-0", empty ? "font-medium text-ink-soft" : "font-semibold")}>
          {row.name} <span className="font-medium text-ink-soft">({row.code})</span>
        </span>
        {row.count == null ? null : empty ? (
          <span className="text-caption text-ink-soft">Aucune vente à venir</span>
        ) : (
          <span className="text-sm font-bold tabular-nums">
            {numbers.format(row.count)}
            <span className="sr-only"> {row.count > 1 ? "ventes" : "vente"} à venir</span>
          </span>
        )}
        {row.count ? (
          <span aria-hidden className="col-span-2 h-1 overflow-hidden rounded-full bg-line-soft">
            <span
              className="block h-full rounded-full bg-gold"
              style={{ width: `${Math.max(3, (row.count / maxCount) * 100).toFixed(1)}%` }}
            />
          </span>
        ) : null}
      </Link>
    </li>
  );
}

const GRID = "grid gap-x-7 gap-y-1 sm:grid-cols-2 lg:grid-cols-3";

/**
 * Recherche d'un département et liste « Tous les départements » de l'index. La liste complète est
 * rendue par le serveur (référencement, page sans JavaScript) ; le navigateur n'ajoute que le
 * filtre en direct (nom ou numéro, sans tenir compte des accents) et le classement (par région, par
 * nombre de ventes, de A à Z). `overview` (carte et classement, rendus par le serveur) se place
 * entre la recherche et la liste.
 */
export function DepartmentDirectory({
  rows,
  regions,
  overview,
  action,
  searchIcon,
}: {
  rows: readonly DepartmentDirectoryRow[];
  /** Les régions, dans l'ordre de la liste. */
  regions: readonly string[];
  overview?: ReactNode;
  /** À côté du champ (le lien vers la carte de toutes les ventes), rendu par le serveur. */
  action?: ReactNode;
  /** Icône du champ, rendue par le serveur (rien de plus à envoyer au navigateur). */
  searchIcon?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("region");
  const withCounts = rows.some((row) => row.count != null);
  const maxCount = Math.max(1, ...rows.map((row) => row.count ?? 0));

  const needle = searchable(query);
  const visible = needle
    ? rows.filter(
        (row) => searchable(row.name).includes(needle) || row.code.toLowerCase().startsWith(needle),
      )
    : rows;

  const modes: SortMode[] = withCounts ? ["region", "count", "alpha"] : ["region", "alpha"];
  const sorted =
    sort === "region"
      ? null
      : [...visible].sort((a, b) =>
          sort === "count"
            ? (b.count ?? 0) - (a.count ?? 0) || a.name.localeCompare(b.name, "fr")
            : a.name.localeCompare(b.name, "fr"),
        );

  return (
    <>
      <form
        role="search"
        aria-label="Trouver un département"
        className="mt-6 flex flex-wrap items-center gap-2.5"
        onSubmit={(event) => event.preventDefault()}
      >
        <label
          htmlFor="recherche-departement"
          className="relative min-w-0 flex-[1_1_20rem] sm:max-w-[32.5rem]"
        >
          <span className="sr-only">Trouver un département</span>
          {searchIcon}
          <input
            id="recherche-departement"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Nom ou numéro, par exemple Gironde ou 33"
            autoComplete="off"
            className="h-[50px] w-full rounded-md border border-field-border bg-white pr-3.5 pl-11 text-base text-foreground placeholder:text-ink-soft focus-visible:border-gold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
          />
        </label>
        {action}
      </form>

      {overview}

      <section aria-labelledby="tous-les-departements">
        <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3.5">
          <h2 id="tous-les-departements" className="font-display text-2xl font-semibold">
            Tous les départements
          </h2>
          <div
            role="group"
            aria-label="Classer la liste"
            className="inline-flex flex-wrap rounded-full border border-line bg-white p-[3px]"
          >
            {modes.map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={sort === mode}
                onClick={() => setSort(mode)}
                className={cn(
                  "min-h-11 cursor-pointer rounded-full px-3.5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft motion-reduce:transition-none",
                  sort === mode
                    ? "bg-brand-navy text-white"
                    : "text-brand-navy hover:bg-surface-tint",
                )}
              >
                {SORT_LABELS[mode]}
              </button>
            ))}
          </div>
        </div>

        <p aria-live="polite" className="sr-only">
          {query.trim()
            ? `${visible.length} ${visible.length > 1 ? "départements" : "département"}`
            : ""}
        </p>

        {visible.length === 0 ? (
          <p className="py-7 text-ink-soft">
            Aucun département ne correspond à « {query.trim()} ».
          </p>
        ) : sorted ? (
          <ul className={cn(GRID, "py-5")}>
            {sorted.map((row) => (
              <DepartmentRow key={row.code} row={row} maxCount={maxCount} />
            ))}
          </ul>
        ) : (
          regions.map((region) => {
            const inRegion = visible.filter((row) => row.region === region);
            if (!inRegion.length) return null;
            const all = rows.filter((row) => row.region === region);
            const total = all.reduce((sum, row) => sum + (row.count ?? 0), 0);
            return (
              <div key={region} className="border-b border-line-soft py-5 last:border-b-0">
                <h3 className="mb-2.5 flex flex-wrap items-baseline gap-x-2.5 text-lg font-bold">
                  {region}
                  {withCounts ? (
                    <span className="text-sm font-medium text-ink-soft">{salesPhrase(total)}</span>
                  ) : null}
                </h3>
                <ul className={GRID}>
                  {inRegion.map((row) => (
                    <DepartmentRow key={row.code} row={row} maxCount={maxCount} />
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </section>
    </>
  );
}
