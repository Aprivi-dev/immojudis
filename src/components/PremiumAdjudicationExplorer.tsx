"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import BadgeEuro from "lucide-react/dist/esm/icons/badge-euro.js";
import { BillingActions } from "@/components/BillingActions";
import { useAuth } from "@/hooks/use-auth";
import { fetchAccessPlan } from "@/lib/client-api";
import { fetchAdjudicationPriceStatisticsDirectory } from "@/lib/adjudication-price-statistics-client";
import type { AdjudicationPriceStatisticsScope } from "@/lib/adjudication-price-statistics";

const euro = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});
const integer = new Intl.NumberFormat("fr-FR");
const percent = new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 0 });
const ratio = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });

export function PremiumAdjudicationExplorer({
  selectedCourtCode,
}: {
  selectedCourtCode: string | null;
}) {
  const { session, loading: authLoading } = useAuth();
  const [courtChoice, setCourtChoice] = useState("");
  const [propertyType, setPropertyType] = useState("");
  useEffect(() => {
    setCourtChoice("");
    setPropertyType("");
  }, [selectedCourtCode]);

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
  const preferredCourt = data?.tribunals.find(
    (item) => item.courtCode === selectedCourtCode,
  )?.courtCode;
  const activeCode = courtChoice || preferredCourt || data?.tribunals[0]?.courtCode || "";
  const activeCourt = data?.tribunals.find((item) => item.courtCode === activeCode) ?? null;
  const activeType = activeCourt?.propertyTypes?.find((item) => item.propertyType === propertyType);

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
        Prix déclarés par Licitor, comparés aux mises à prix sur des ventes passées. La médiane
        décrit le milieu de l’échantillon ; elle est moins sensible aux ventes atypiques qu’une
        moyenne. Ces prix ne sont pas confirmés par le greffe et ne prédisent pas le prix d’un bien.
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
            Consultez les prix médians, les fourchettes et la taille des échantillons nationaux et
            par tribunal après connexion ou activation de l’offre.
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
        <div className="mt-7 space-y-6">
          <ScopeSummary scope={data.national} title="France · échantillon contrôlé" />
          <div className="border-t border-brand-navy/12 pt-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h3 className="font-display text-2xl font-semibold">Zoom sur un tribunal</h3>
                <p className="mt-1 text-xs text-brand-navy/60">
                  {data.tribunals.length} tribunaux disposent d’au moins 10 prix publiés
                  exploitables.
                </p>
              </div>
              <label className="text-xs font-semibold text-brand-navy/70 sm:w-80">
                Tribunal
                <select
                  value={activeCode}
                  onChange={(event) => {
                    setCourtChoice(event.target.value);
                    setPropertyType("");
                  }}
                  className="mt-2 h-11 w-full rounded-md border border-brand-navy/20 bg-white px-3 text-sm text-brand-navy"
                >
                  {data.tribunals.map((item) => (
                    <option key={item.courtCode} value={item.courtCode ?? ""}>
                      {item.label} · {integer.format(item.sampleSize)} prix
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {activeCourt ? (
              <>
                <ScopeSummary scope={activeCourt} title={activeCourt.label} />
                {activeCourt.propertyTypes?.length ? (
                  <div className="mt-5 rounded-lg border border-brand-navy/12 bg-[#f8fbfe] p-4">
                    <label className="text-xs font-semibold text-brand-navy/70">
                      Affiner les prix publiés par type de bien
                      <select
                        value={propertyType}
                        onChange={(event) => setPropertyType(event.target.value)}
                        className="mt-2 block h-10 w-full max-w-sm rounded-md border border-brand-navy/20 bg-white px-3 text-sm text-brand-navy"
                      >
                        <option value="">Tous types confondus</option>
                        {activeCourt.propertyTypes.map((item) => (
                          <option key={item.propertyType} value={item.propertyType}>
                            {propertyTypeLabel(item.propertyType)} ·{" "}
                            {integer.format(item.distribution.sampleSize)}
                          </option>
                        ))}
                      </select>
                    </label>
                    {activeType ? (
                      <p className="mt-4 text-sm leading-relaxed text-brand-navy/75">
                        {integer.format(activeType.distribution.sampleSize)} prix publiés pour ce
                        type · moitié centrale des prix adjugés :{" "}
                        <strong>
                          {euro.format(activeType.distribution.hammerPriceMiddle50Eur.p25)} à{" "}
                          {euro.format(activeType.distribution.hammerPriceMiddle50Eur.p75)}
                        </strong>
                        . Cette fourchette n’est pas une estimation du bien.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : (
              <p className="mt-5 text-sm text-brand-navy/65">
                Aucun tribunal n’atteint actuellement le seuil de publication.
              </p>
            )}
          </div>
          <p className="text-xs leading-relaxed text-brand-navy/65">
            {data.meta.warning} Période : {formatDate(data.national.periodStart)} au{" "}
            {formatDate(data.national.periodEnd)}. Mise à jour validée le{" "}
            {formatDate(data.meta.reviewedAt)}. Les délais affichés plus bas proviennent du
            catalogue Immojudis, pas de Licitor ; ils mesurent la détection d’une annonce jusqu’à
            l’audience, pas un délai de décision judiciaire.
          </p>
        </div>
      )}
    </section>
  );
}

function ScopeSummary({
  scope,
  title,
}: {
  scope: AdjudicationPriceStatisticsScope;
  title: string;
}) {
  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-display text-xl font-semibold text-brand-navy">{title}</h3>
        <span className="rounded-full bg-brand-navy/8 px-3 py-1 text-xs font-semibold text-brand-navy">
          {integer.format(scope.sampleSize)} prix publiés ·{" "}
          {scope.reliability === "limited" ? "échantillon limité" : "échantillon descriptif"}
        </span>
      </div>
      <dl className="mt-4 grid overflow-hidden rounded-lg border border-brand-navy/12 bg-[#f8fbfe] sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="Prix adjugé médian"
          value={euro.format(scope.metrics.medianHammerPriceEur)}
          detail="Parmi les prix publiés, tous biens confondus"
        />
        <Metric
          label="Mise à prix médiane"
          value={euro.format(scope.metrics.medianStartingPriceEur)}
          detail="Même échantillon de ventes"
        />
        <Metric
          label="Ratio médian adjugé / mise"
          value={`× ${ratio.format(scope.metrics.medianHammerToStartingRatio)}`}
          detail="Médiane des ratios vente par vente"
        />
        <Metric
          label="Au-dessus de la mise à prix"
          value={percent.format(scope.metrics.aboveStartingRate)}
          detail={`Sur ${integer.format(scope.sampleSize)} prix connus`}
        />
      </dl>
      {scope.distribution ? (
        <p className="mt-3 text-xs text-brand-navy/65">
          Moitié centrale des prix adjugés :{" "}
          {euro.format(scope.distribution.hammerPriceMiddle50Eur.p25)} à{" "}
          {euro.format(scope.distribution.hammerPriceMiddle50Eur.p75)}.{" "}
          {scope.reliability === "limited"
            ? "Petit échantillon : variation potentiellement forte."
            : "Valeurs descriptives, non prédictives."}
        </p>
      ) : null}
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="border-b border-brand-navy/10 p-4 last:border-0 xl:border-b-0 xl:border-r xl:last:border-r-0">
      <dt className="text-xs font-semibold uppercase tracking-wide text-brand-navy/60">{label}</dt>
      <dd className="mt-2 font-display text-2xl font-semibold tabular-nums text-brand-navy">
        {value}
      </dd>
      <p className="mt-1 text-xs text-brand-navy/55">{detail}</p>
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function propertyTypeLabel(value: string) {
  return (
    (
      {
        apartment: "Appartement",
        house: "Maison",
        building: "Immeuble",
        commercial: "Local commercial",
        land: "Terrain",
        parking: "Parking",
        mixed: "Bien mixte",
      } as Record<string, string>
    )[value] ?? value
  );
}
