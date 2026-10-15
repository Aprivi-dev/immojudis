"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/primitives";
import { fetchCourtAuctionSummaries } from "@/lib/client-api";
import { formatEuro, formatPercent, formatRatio } from "@/lib/auction-scenarios";

const number = new Intl.NumberFormat("fr-FR");

/**
 * Trois ans d'adjudications par tribunal : moyennes Licitor (mise à prix, prix
 * final, part adjugée à au moins 2 fois la mise à prix) et volumes officiels DVF. Analyse members only;
 * the caller checks the plan before rendering.
 */
export function CourtAuctionSummaryTable() {
  const [filter, setFilter] = useState("");
  const query = useQuery({
    queryKey: ["court-auction-summaries"],
    queryFn: fetchCourtAuctionSummaries,
    retry: false,
    staleTime: 30 * 60_000,
  });
  if (query.isLoading) {
    return (
      <p className="mt-8 text-sm text-brand-navy/65" role="status">
        Chargement des moyennes par tribunal…
      </p>
    );
  }
  // Une erreur n'est pas une absence de données : on le dit et on propose de réessayer.
  if (query.isError) {
    return (
      <div className="mt-10" id="moyennes-tribunaux" role="alert">
        <p className="text-sm font-semibold text-brand-navy">
          Les statistiques du tribunal n’ont pas pu être chargées.
        </p>
        <Button className="mt-3" onClick={() => void query.refetch()}>
          Réessayer
        </Button>
      </div>
    );
  }
  const courts = query.data?.courts ?? [];
  if (!courts.length) return null;
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? courts.filter((court) => court.courtName.toLowerCase().includes(needle))
    : courts;

  return (
    <div className="mt-10" id="moyennes-tribunaux">
      <h3 className="font-display text-2xl font-semibold text-brand-navy">
        Moyennes par tribunal sur trois ans
      </h3>
      <p className="mt-2 max-w-4xl text-sm leading-relaxed text-brand-navy/70">
        Mise à prix et prix final moyens des ventes adjugées (Licitor), part des ventes adjugées à
        au moins 2 fois la mise à prix, et nombre d’adjudications enregistrées par l’administration
        fiscale dans le ressort du tribunal (DVF).
      </p>
      <label className="mt-4 block text-sm font-semibold text-brand-navy" htmlFor="court-filter">
        Rechercher un tribunal
      </label>
      <input
        id="court-filter"
        type="search"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        className="mt-1 w-full max-w-sm rounded-lg border border-brand-navy/20 px-3 py-2 text-sm"
        placeholder="Ex. Bobigny"
      />
      {visible.length === 0 ? (
        <p className="mt-4 text-sm text-brand-navy/70" role="status">
          Aucun tribunal ne correspond à « {filter.trim()} ».
        </p>
      ) : (
        <div
          role="region"
          tabIndex={0}
          aria-label="Moyennes par tribunal, défilement horizontal"
          className="mt-4 overflow-x-auto outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-gold"
        >
          <table className="w-full min-w-[640px] text-left text-sm">
            <caption className="sr-only">
              Moyennes par tribunal sur trois ans : ventes adjugées, mise à prix et prix final
              moyens, part des ventes adjugées à au moins 2 fois la mise à prix et adjudications DVF
            </caption>
            <thead className="text-xs uppercase tracking-wide text-brand-navy/60">
              <tr>
                <th scope="col" className="sticky left-0 z-10 bg-white py-2 pr-4">
                  Tribunal
                </th>
                <th scope="col" className="py-2 pr-4">
                  Ventes adjugées
                </th>
                <th scope="col" className="py-2 pr-4">
                  Mise à prix moyenne
                </th>
                <th scope="col" className="py-2 pr-4">
                  Prix final moyen
                </th>
                <th scope="col" className="py-2 pr-4">
                  Prix final / mise à prix
                </th>
                <th scope="col" className="py-2 pr-4">
                  Adjugées à au moins 2 fois la mise à prix
                </th>
                <th scope="col" className="py-2">
                  Adjudications DVF
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((court) => (
                <tr key={court.courtCode} className="border-t border-brand-navy/10">
                  <th
                    scope="row"
                    className="sticky left-0 z-10 bg-white py-2 pr-4 font-semibold text-brand-navy"
                  >
                    {court.courtName}
                  </th>
                  <td className="py-2 pr-4">
                    {court.licitor ? number.format(court.licitor.sample) : "—"}
                  </td>
                  <td className="py-2 pr-4">{formatEuro(court.licitor?.meanStartingPrice)}</td>
                  <td className="py-2 pr-4">{formatEuro(court.licitor?.meanHammerPrice)}</td>
                  <td className="py-2 pr-4">{formatRatio(court.licitor?.medianRatio)}</td>
                  <td className="py-2 pr-4">{formatPercent(court.licitor?.atLeastDoubleRate)}</td>
                  <td className="py-2">{court.dvf ? number.format(court.dvf.sample) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-brand-navy/60">
        Rapport prix final / mise à prix : valeur du milieu. Un tribunal apparaît à partir de 10
        ventes. Les moyennes sont tirées vers le haut par quelques ventes très disputées.
      </p>
    </div>
  );
}
