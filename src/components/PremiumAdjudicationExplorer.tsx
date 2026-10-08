"use client";

import { useQuery } from "@tanstack/react-query";
import BadgeEuro from "lucide-react/dist/esm/icons/badge-euro.js";
import { BillingActions } from "@/components/BillingActions";
import { useAuth } from "@/hooks/use-auth";
import { fetchAccessPlan } from "@/lib/client-api";
import { fetchAdjudicationPriceStatisticsDirectory } from "@/lib/adjudication-price-statistics-client";
import { AdjudicationBarometer } from "@/components/AdjudicationBarometer";

export function PremiumAdjudicationExplorer({
  selectedCourtCode = null,
}: {
  selectedCourtCode?: string | null;
} = {}) {
  const { session, loading: authLoading } = useAuth();
  const planQuery = useQuery({
    queryKey: ["adjudication-statistics-plan", session?.user.id],
    queryFn: fetchAccessPlan,
    enabled: Boolean(session) && !authLoading,
    retry: false,
    staleTime: 5 * 60_000,
  });
  const hasAccess = planQuery.data?.plan.hasAnalysisAccess === true;
  const statisticsQuery = useQuery({
    queryKey: ["adjudication-price-statistics-directory", session?.user.id],
    queryFn: fetchAdjudicationPriceStatisticsDirectory,
    enabled: Boolean(session) && hasAccess,
    retry: false,
    staleTime: 5 * 60_000,
  });
  const data = statisticsQuery.data;

  return (
    <section
      id="adjudications-licitor"
      aria-labelledby="adjudications-licitor-title"
      className="scroll-mt-28 rounded-xl border border-brand-navy/15 bg-white p-5 shadow-sm sm:p-7"
    >
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.13em] text-gold-soft">
        <BadgeEuro className="h-4 w-4" aria-hidden /> Résultats publiés · Offre Analyse
      </p>
      <h2
        id="adjudications-licitor-title"
        className="mt-2 font-display text-3xl font-semibold text-brand-navy sm:text-4xl"
      >
        Prix d’adjudication par tribunal
      </h2>
      <p className="mt-3 max-w-4xl text-sm leading-relaxed text-brand-navy/70">
        Les prix publiés par Licitor permettent de situer une vente par rapport aux résultats
        observés. Chaque chiffre porte sur un échantillon identifié, avec sa période et ses limites.
      </p>

      {authLoading || (session && planQuery.isLoading) ? (
        <p className="mt-6 text-sm text-brand-navy/65" role="status">
          Vérification de votre accès Analyse…
        </p>
      ) : planQuery.isError ? (
        <div
          className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm"
          role="alert"
        >
          Impossible de vérifier votre accès.{" "}
          <button
            type="button"
            className="font-semibold underline"
            onClick={() => void planQuery.refetch()}
          >
            Réessayer
          </button>
        </div>
      ) : !hasAccess ? (
        <div className="mt-6 rounded-lg border border-brand-navy/12 bg-[#f8fbfe] p-5">
          <p className="font-semibold text-brand-navy">
            Les résultats chiffrés sont réservés aux membres Analyse.
          </p>
          <p className="mt-2 text-sm text-brand-navy/65">
            Accédez aux prix médians, aux répartitions des résultats, aux comparaisons par type de
            bien et au tableau des tribunaux avec export CSV.
          </p>
          <BillingActions className="mt-5" hideHelper />
        </div>
      ) : statisticsQuery.isLoading ? (
        <p className="mt-6 text-sm text-brand-navy/65" role="status">
          Chargement des résultats d’adjudication…
        </p>
      ) : statisticsQuery.isError || !data ? (
        <div
          className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm"
          role="alert"
        >
          Les résultats d’adjudication sont momentanément indisponibles.{" "}
          <button
            type="button"
            className="font-semibold underline"
            onClick={() => void statisticsQuery.refetch()}
          >
            Réessayer
          </button>
        </div>
      ) : (
        <AdjudicationBarometer
          key={selectedCourtCode ?? "national"}
          data={data}
          initialCourtCode={selectedCourtCode}
        />
      )}
    </section>
  );
}
