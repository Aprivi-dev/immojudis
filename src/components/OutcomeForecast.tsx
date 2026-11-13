"use client";

import { useMemo, useState } from "react";
import Ban from "lucide-react/dist/esm/icons/ban.js";
import CalendarClock from "lucide-react/dist/esm/icons/calendar-clock.js";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days.js";
import ChartNoAxesCombined from "lucide-react/dist/esm/icons/chart-no-axes-combined.js";
import CircleDashed from "lucide-react/dist/esm/icons/circle-dashed.js";
import Gavel from "lucide-react/dist/esm/icons/gavel.js";
import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import TrendingUp from "lucide-react/dist/esm/icons/trending-up.js";
import Users from "lucide-react/dist/esm/icons/users.js";
import type { OutcomeGraphForecastQuery } from "@/hooks/use-outcome-graph-forecast";
import { formatDate, formatPrice, formatShareAsPercent } from "@/lib/format";
import {
  ceilingProbabilityReading,
  cumulativeProbability,
  roundProbabilityToFivePercent,
  withOutcomeGraphCeiling,
  type CeilingProbabilityReading,
  type OutcomeGraphForecast,
  type OutcomeGraphQuantiles,
} from "@/lib/outcome-graph";

export function OutcomeForecast({ forecastQuery }: { forecastQuery: OutcomeGraphForecastQuery }) {
  const [ceilingDraft, setCeilingDraft] = useState("");

  const forecast = forecastQuery.data?.forecast;
  if (!forecast || forecast.status !== "ready") {
    return null;
  }

  return (
    <OutcomeForecastReady
      forecast={forecast}
      ceilingDraft={ceilingDraft}
      onCeilingDraftChange={setCeilingDraft}
    />
  );
}

function OutcomeForecastReady({
  forecast,
  ceilingDraft,
  onCeilingDraftChange,
}: {
  forecast: OutcomeGraphForecast;
  ceilingDraft: string;
  onCeilingDraftChange: (value: string) => void;
}) {
  const initialCeilingCents = forecast.ceiling?.amountCents ?? forecast.finalPrice?.p50Cents ?? 0;
  const parsedCeiling = Number(ceilingDraft);
  const ceilingCents =
    ceilingDraft && Number.isFinite(parsedCeiling) && parsedCeiling >= 0
      ? Math.round(parsedCeiling * 100)
      : initialCeilingCents;
  const displayedForecast = useMemo(
    () => withOutcomeGraphCeiling(forecast, ceilingCents),
    [ceilingCents, forecast],
  );
  const ceiling = displayedForecast.ceiling!;
  const ceilingReading = ceilingProbabilityReading(
    displayedForecast.finalPrice!,
    ceiling.amountCents,
  );
  const combinedReading = scaleReading(
    ceilingReading,
    (displayedForecast.flow.heldProbability ?? 0) *
      (displayedForecast.flow.adjudicatedIfHeldProbability ?? 0),
  );

  const flowSteps = [
    {
      label: "Audience tenue",
      value: displayedForecast.flow.heldProbability,
      icon: Users,
      tone: "navy" as const,
    },
    {
      label: "Adjudication si audience tenue",
      value: displayedForecast.flow.adjudicatedIfHeldProbability,
      icon: Gavel,
      tone: "gold" as const,
    },
    {
      label: "Enchères désertes si audience tenue",
      value: displayedForecast.flow.noBidIfHeldProbability,
      icon: CircleDashed,
      tone: "muted" as const,
    },
    {
      label: "Report",
      value: displayedForecast.flow.postponedProbability,
      icon: CalendarClock,
      tone: "muted" as const,
    },
    {
      label: "Annulation ou vente non requise",
      value: displayedForecast.flow.cancelledOrNotRequestedProbability,
      icon: Ban,
      tone: "muted" as const,
    },
  ];

  return (
    <section
      id="outcome-forecast"
      aria-labelledby="outcome-forecast-title"
      className="scroll-mt-2 border-b border-brand-navy/10 bg-background"
    >
      <div className="mx-auto max-w-[1410px] px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
        <h2
          id="outcome-forecast-title"
          className="font-display text-4xl font-medium text-brand-navy sm:text-5xl"
        >
          Prévision de l’audience
        </h2>

        <div className="relative mt-9 md:grid md:grid-cols-5 md:gap-5">
          <div
            aria-hidden
            className="absolute left-[1.35rem] top-6 hidden h-px w-[calc(100%-2.7rem)] bg-brand-navy/15 md:block"
          />
          <div
            aria-hidden
            className="absolute bottom-5 left-[1.35rem] top-6 w-px bg-brand-navy/15 md:hidden"
          />
          {flowSteps.map((step) => (
            <FlowStep key={step.label} {...step} />
          ))}
        </div>

        <div className="mt-10 grid gap-8 border-y border-brand-navy/14 py-8 lg:grid-cols-2 lg:gap-0">
          <PriceDistribution
            label="Prix initial médian estimé"
            quantiles={displayedForecast.initialPrice!}
            className="lg:pr-10"
          />
          <div className="border-t border-brand-navy/14 pt-8 lg:border-l lg:border-t-0 lg:pl-10 lg:pt-0">
            <PriceDistribution
              label="Prix définitif médian estimé"
              quantiles={displayedForecast.finalPrice!}
            />
            <p className="mt-6 text-base font-medium text-brand-navy sm:text-lg">
              Probabilité de surenchère{" "}
              <strong className="ml-1 font-display text-2xl font-semibold text-gold-text">
                <ApproximateProbability
                  inline
                  reading={
                    displayedForecast.surenchereProbability == null
                      ? null
                      : estimateReading(displayedForecast.surenchereProbability)
                  }
                />
              </strong>
            </p>
          </div>
        </div>

        <div className="mt-8 overflow-hidden rounded-lg border border-brand-navy/18 bg-white shadow-[0_18px_45px_rgba(72,104,132,0.08)]">
          <div className="grid lg:grid-cols-[minmax(250px,0.72fr)_minmax(0,1.65fr)]">
            <div className="border-b border-brand-navy/12 p-5 sm:p-7 lg:border-b-0 lg:border-r">
              <label
                htmlFor="outcome-ceiling"
                className="block font-display text-2xl font-semibold text-brand-navy"
              >
                Votre plafond
              </label>
              <div className="relative mt-4 max-w-[17rem]">
                <input
                  id="outcome-ceiling"
                  type="number"
                  min={0}
                  step={5_000}
                  value={ceilingDraft || String(Math.round(initialCeilingCents / 100))}
                  onChange={(event) => onCeilingDraftChange(event.target.value)}
                  className="h-14 w-full rounded-md border border-brand-navy/20 bg-white px-4 pr-12 font-display text-2xl font-semibold text-brand-navy transition focus:border-gold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
                  aria-describedby="outcome-ceiling-help"
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 right-4 flex items-center font-display text-xl text-brand-navy/65"
                >
                  €
                </span>
              </div>
              <p
                id="outcome-ceiling-help"
                className="mt-3 text-xs leading-relaxed text-brand-navy/70"
              >
                Ce montant reste dans votre navigateur et n’alimente aucune cohorte.
              </p>

              <div className="mt-7 border-t border-brand-navy/12 pt-6">
                <p className="font-display text-6xl font-medium leading-none text-gold-text sm:text-7xl">
                  <ApproximateProbability reading={ceilingReading} />
                </p>
                <p className="mt-3 max-w-sm text-sm font-medium leading-relaxed text-brand-navy sm:text-base">
                  Probabilité que le prix final reste inférieur ou égal à votre plafond, si le lot
                  est adjugé
                </p>
                <p className="mt-2 max-w-sm text-xs leading-relaxed text-brand-navy/65">
                  Arrondie à 5 % près. Elle se lit sur trois repères estimés (10 %, 50 % et 90 %) et
                  ne tient pas compte de la concurrence le jour de la vente.
                </p>
                <p className="mt-4 text-xs leading-relaxed text-brand-navy/65">
                  Probabilité combinée avec une adjudication :{" "}
                  <strong className="text-brand-navy">
                    <ApproximateProbability inline reading={combinedReading} />
                  </strong>
                </p>
              </div>
            </div>

            <div className="min-w-0 p-4 sm:p-7">
              <CeilingCurve
                quantiles={displayedForecast.finalPrice!}
                ceilingCents={ceiling.amountCents}
                reading={ceilingReading}
              />
            </div>
          </div>
        </div>

        <ForecastMeta forecast={displayedForecast} />

        <details className="mt-7 border-t border-brand-navy/12 pt-5 text-sm text-brand-navy/68">
          <summary className="cursor-pointer font-semibold text-brand-navy">
            Méthode, facteurs et limites
          </summary>
          <div className="mt-4 grid gap-6 lg:grid-cols-2">
            <ul className="space-y-2">
              {displayedForecast.explanationFactors.map((factor) => (
                <li key={factor.label}>
                  <strong className="text-brand-navy">{factor.label} :</strong> {factor.detail}
                </li>
              ))}
            </ul>
            <ul className="list-disc space-y-2 pl-5">
              {displayedForecast.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          </div>
        </details>
      </div>
    </section>
  );
}

function FlowStep({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number | null;
  icon: typeof Users;
  tone: "navy" | "gold" | "muted";
}) {
  const toneClass =
    tone === "navy"
      ? "border-brand-navy bg-brand-navy text-white"
      : tone === "gold"
        ? "border-gold bg-white text-gold-text"
        : "border-brand-navy/18 bg-white text-brand-navy/65";
  return (
    <div className="relative grid grid-cols-[2.75rem_minmax(0,1fr)] gap-4 pb-7 last:pb-0 md:block md:pb-0 md:text-center">
      <span
        className={`relative z-10 grid h-11 w-11 place-items-center rounded-full border ${toneClass} md:mx-auto`}
      >
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <div className="pt-0.5 md:mt-3 md:pt-0">
        <p
          className={`text-sm font-medium ${tone === "gold" ? "text-gold-text" : "text-brand-navy/72"}`}
        >
          {label}
        </p>
        <p
          className={`mt-1 font-display text-4xl font-medium leading-none ${tone === "gold" ? "text-gold-text" : "text-brand-navy"}`}
        >
          <ApproximateProbability reading={value == null ? null : estimateReading(value)} />
        </p>
      </div>
    </div>
  );
}

function PriceDistribution({
  label,
  quantiles,
  className = "",
}: {
  label: string;
  quantiles: OutcomeGraphQuantiles;
  className?: string;
}) {
  // Une échelle en euros : chaque repère est placé à sa vraie position, pas à une place fixe.
  const span = Math.max(1, quantiles.p90Cents - quantiles.p10Cents);
  const lowCents = Math.max(0, quantiles.p10Cents - span * 0.25);
  const highCents = quantiles.p90Cents + span * 0.25;
  const position = (cents: number) =>
    `${(Math.min(1, Math.max(0, (cents - lowCents) / (highCents - lowCents))) * 100).toFixed(1)}%`;
  return (
    <div className={className}>
      <p className="text-base font-medium text-brand-navy sm:text-lg">{label}</p>
      <p className="mt-2 font-display text-5xl font-medium leading-none text-brand-navy sm:text-6xl">
        {formatPrice(euros(quantiles.p50Cents))}
      </p>
      <p className="mt-4 text-sm text-brand-navy/72 sm:text-base">
        Fourchette probable à 80 % :{" "}
        <strong className="font-display text-xl font-semibold text-gold-text">
          {formatPrice(euros(quantiles.p10Cents))} – {formatPrice(euros(quantiles.p90Cents))}
        </strong>
      </p>
      <div className="mt-7">
        <p className="text-xs text-brand-navy/66">
          Repères sur une échelle en euros : 10 %, médiane et 90 %.
        </p>
        <div className="relative mt-3 h-1 rounded-full bg-brand-navy/12" aria-hidden>
          <span
            className="absolute inset-y-0 bg-gold"
            style={{
              left: position(quantiles.p10Cents),
              right: `calc(100% - ${position(quantiles.p90Cents)})`,
            }}
          />
          <span
            className="absolute -top-1 h-3 w-px bg-brand-navy/65"
            style={{ left: position(quantiles.p10Cents) }}
          />
          <span
            className="absolute -top-1 h-3 w-px bg-brand-navy"
            style={{ left: position(quantiles.p50Cents) }}
          />
          <span
            className="absolute -top-1 h-3 w-px bg-brand-navy/65"
            style={{ left: position(quantiles.p90Cents) }}
          />
        </div>
        <div className="mt-1 flex justify-between text-xs tabular-nums text-brand-navy/55">
          <span>{formatPrice(euros(lowCents))}</span>
          <span>Prix, en euros</span>
          <span>{formatPrice(euros(highCents))}</span>
        </div>
        <dl className="mt-3 grid grid-cols-3 font-display text-base font-semibold text-brand-navy/72 sm:text-lg">
          <div>
            <dt className="font-sans text-xs font-normal text-brand-navy/66">10 %</dt>
            <dd>{formatPrice(euros(quantiles.p10Cents))}</dd>
          </div>
          <div className="text-center">
            <dt className="font-sans text-xs font-normal text-brand-navy/66">Médiane</dt>
            <dd className="text-gold-text">{formatPrice(euros(quantiles.p50Cents))}</dd>
          </div>
          <div className="text-right">
            <dt className="font-sans text-xs font-normal text-brand-navy/66">90 %</dt>
            <dd>{formatPrice(euros(quantiles.p90Cents))}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function CeilingCurve({
  quantiles,
  ceilingCents,
  reading,
}: {
  quantiles: OutcomeGraphQuantiles;
  ceilingCents: number;
  reading: CeilingProbabilityReading;
}) {
  // Un graphique étroit, qui se réduit avec l'écran au lieu de défiler : les textes restent lisibles.
  const width = 480;
  const height = 320;
  const padding = { left: 62, right: 16, top: 16, bottom: 74 };
  const span = Math.max(1, quantiles.p90Cents - quantiles.p10Cents);
  const minPrice = Math.max(0, quantiles.p10Cents - span * 0.2);
  const maxPrice = quantiles.p90Cents + span * 0.2;
  const x = (price: number) =>
    padding.left +
    ((Math.min(maxPrice, Math.max(minPrice, price)) - minPrice) / (maxPrice - minPrice)) *
      (width - padding.left - padding.right);
  const y = (value: number) => padding.top + (1 - value) * (height - padding.top - padding.bottom);
  // La courbe n'est tracée en plein qu'entre P10 et P90, les seuls repères estimés.
  const points = Array.from({ length: 41 }, (_, index) => {
    const price = quantiles.p10Cents + (span * index) / 40;
    return `${x(price).toFixed(1)},${y(cumulativeProbability(quantiles, price)).toFixed(1)}`;
  }).join(" ");
  const insideCurve = reading.kind === "estimate";
  const markerX = x(ceilingCents);
  const markerY = y(reading.probability);
  const ticks = [quantiles.p10Cents, quantiles.p50Cents, quantiles.p90Cents];
  const axisBottom = height - padding.bottom;
  const readingText = describeReading(reading);

  return (
    <div>
      <h3 className="font-display text-2xl font-semibold text-brand-navy">
        Distribution du prix définitif
      </h3>
      <p className="mt-1 text-sm text-brand-navy/70">
        Lecture conditionnelle à une adjudication. La courbe est tracée de 10 % à 90 % seulement :
        au delà, la distribution n’est pas estimée.
      </p>
      <div className="mt-5" role="region" aria-label="Graphique cumulatif du prix définitif">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-auto w-full"
          role="img"
          aria-label={`Courbe cumulative du prix définitif, tracée entre ${formatPrice(euros(quantiles.p10Cents))} et ${formatPrice(euros(quantiles.p90Cents))} : ${readingText} pour un plafond de ${formatPrice(euros(ceilingCents))}`}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
            <g key={tick}>
              <line
                x1={padding.left}
                x2={width - padding.right}
                y1={y(tick)}
                y2={y(tick)}
                stroke="rgba(19,34,56,0.15)"
                strokeDasharray={tick === 0 ? undefined : "5 5"}
              />
              <text
                x={padding.left - 8}
                y={y(tick) + 4}
                textAnchor="end"
                className="fill-brand-navy/70 text-[13px]"
              >
                {formatShareAsPercent(tick)}
              </text>
            </g>
          ))}
          <text
            transform={`translate(14 ${(padding.top + axisBottom) / 2}) rotate(-90)`}
            textAnchor="middle"
            className="fill-brand-navy/70 text-[12px]"
          >
            Probabilité cumulée
          </text>
          <polyline points={points} fill="none" stroke="var(--brand-navy)" strokeWidth="3" />
          {insideCurve ? (
            <>
              <line
                x1={padding.left}
                x2={markerX}
                y1={markerY}
                y2={markerY}
                stroke="var(--gold)"
                strokeWidth="1.5"
                strokeDasharray="6 5"
              />
              <line
                x1={markerX}
                x2={markerX}
                y1={markerY}
                y2={axisBottom}
                stroke="var(--gold)"
                strokeWidth="1.5"
                strokeDasharray="6 5"
              />
              <circle cx={markerX} cy={markerY} r="6" fill="var(--gold)" />
            </>
          ) : (
            <line
              x1={markerX}
              x2={markerX}
              y1={padding.top}
              y2={axisBottom}
              stroke="var(--gold)"
              strokeWidth="1.5"
              strokeDasharray="6 5"
            />
          )}
          {ticks.map((tick, index) => (
            <text
              key={`${tick}-${index}`}
              x={x(tick)}
              y={axisBottom + 16}
              textAnchor={index === 0 ? "start" : index === ticks.length - 1 ? "end" : "middle"}
              className="fill-brand-navy/70 text-[12px]"
            >
              {formatPrice(euros(tick))}
            </text>
          ))}
          <text
            x={Math.min(width - 50, Math.max(50, markerX))}
            y={axisBottom + 34}
            textAnchor="middle"
            className="fill-gold-text text-[13px] font-semibold"
          >
            Plafond {formatPrice(euros(ceilingCents))}
          </text>
          <text
            x={(padding.left + width - padding.right) / 2}
            y={height - 8}
            textAnchor="middle"
            className="fill-brand-navy/70 text-[12px]"
          >
            Prix définitif, en euros
          </text>
        </svg>
      </div>
      {insideCurve ? null : (
        <p className="mt-2 text-xs text-brand-navy/70">
          Votre plafond est hors de la plage estimée (10 % à 90 %) : seule une borne peut être
          affirmée, pas une valeur.
        </p>
      )}
    </div>
  );
}

function ForecastMeta({ forecast }: { forecast: OutcomeGraphForecast }) {
  const pressure = forecast.pressure;
  const confidence = forecast.confidence;
  const items = [
    {
      icon: TrendingUp,
      label: "Pression concurrentielle",
      value: pressure ? `${pressure.score}/100 — ${pressure.label}` : "À confirmer",
    },
    {
      icon: ShieldCheck,
      label: "Niveau de confiance",
      value: confidence ? capitalize(confidence.label) : "À confirmer",
    },
    {
      icon: ChartNoAxesCombined,
      label: "Échantillon",
      value: confidence ? `${confidence.sampleSize} résultats A/B` : "À confirmer",
    },
    {
      icon: Landmark,
      label: "Résultats dans ce tribunal",
      value: confidence ? String(confidence.tribunalSampleSize) : "À confirmer",
    },
    {
      icon: CalendarDays,
      label: "Date de calcul",
      value: formatCalculationDate(forecast.generatedAt),
    },
  ];

  return (
    <div className="mt-8 grid border-y border-brand-navy/14 sm:grid-cols-2 lg:grid-cols-5">
      {items.map((item) => (
        <div
          key={item.label}
          className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 border-b border-brand-navy/10 px-3 py-5 last:border-b-0 sm:[&:nth-last-child(-n+2)]:border-b-0 lg:border-b-0 lg:border-r lg:last:border-r-0"
        >
          <item.icon className="mt-0.5 h-5 w-5 text-gold-text" aria-hidden />
          <dl>
            <dt className="text-xs text-brand-navy/70">{item.label}</dt>
            <dd className="mt-1 text-sm font-semibold text-brand-navy">{item.value}</dd>
          </dl>
        </div>
      ))}
    </div>
  );
}

function estimateReading(probability: number): CeilingProbabilityReading {
  return { kind: "estimate", probability };
}

/** Applique un facteur (adjudication) à une lecture : une borne reste une borne. */
function scaleReading(
  reading: CeilingProbabilityReading,
  factor: number,
): CeilingProbabilityReading {
  return { ...reading, probability: reading.probability * factor };
}

type ApproximateParts = { prefix: string | null; value: string };

/**
 * Une probabilité telle qu'on peut l'affirmer : arrondie à 5 %, précédée de « environ » (ou de la
 * nature de la borne). Jamais un pourcentage entier qui laisserait croire à une précision absente.
 */
function approximateProbability(reading: CeilingProbabilityReading | null): ApproximateParts {
  if (reading == null) return { prefix: null, value: "Inconnu" };
  const { kind, probability } = reading;
  const rounded = roundProbabilityToFivePercent(
    probability,
    kind === "at_most" ? "up" : kind === "at_least" ? "down" : "nearest",
  );
  const value = formatShareAsPercent(rounded);
  if (kind === "at_most") return { prefix: "au plus environ", value };
  if (kind === "at_least") return { prefix: "au moins environ", value };
  if (probability > 0 && rounded === 0) return { prefix: "moins de", value: "5 %" };
  if (probability < 1 && rounded === 1) return { prefix: "plus de", value: "95 %" };
  return { prefix: "environ", value };
}

function describeReading(reading: CeilingProbabilityReading | null): string {
  const { prefix, value } = approximateProbability(reading);
  return prefix ? `${prefix} ${value}` : value;
}

function ApproximateProbability({
  reading,
  inline = false,
}: {
  reading: CeilingProbabilityReading | null;
  inline?: boolean;
}) {
  const { prefix, value } = approximateProbability(reading);
  if (!prefix) return <>{value}</>;
  return inline ? (
    <>
      {prefix} {value}
    </>
  ) : (
    <>
      <span className="block font-sans text-sm font-medium leading-tight text-brand-navy/70 sm:text-base">
        {prefix}
      </span>{" "}
      {value}
    </>
  );
}

function euros(valueCents: number): number {
  return valueCents / 100;
}

function formatCalculationDate(value: string | null): string {
  if (!value) return "À confirmer";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() <= 1970) return "À confirmer";
  return formatDate(value);
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
