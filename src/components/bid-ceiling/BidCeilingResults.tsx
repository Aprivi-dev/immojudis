import type { Dispatch, ReactNode, SetStateAction } from "react";
import Calculator from "lucide-react/dist/esm/icons/calculator.js";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2.js";
import FileSearch from "lucide-react/dist/esm/icons/file-search.js";
import Home from "lucide-react/dist/esm/icons/home.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import TrendingDown from "lucide-react/dist/esm/icons/trending-down.js";
import Wrench from "lucide-react/dist/esm/icons/wrench.js";
import {
  DEFAULTS,
  REFRESH_WORKS_PRICE_PER_M2,
  type MarketCeilingResult,
  DMTO_TABLE_DATE,
  EMOLUMENT_SCALE_DATE,
  EMOLUMENT_SCALE_REFERENCE,
} from "@/lib/profitability";
import type { MarketEstimate as DvfMarketEstimate } from "@/lib/market.server";
import { marketReferenceConfidence } from "@/lib/market-comparables-analysis";
import { collectSaleDocuments } from "@/lib/sale-documents";
import { documentTypeLabel, formatPrice, occupancyLabel } from "@/lib/format";
import type { AuctionSale, SaleRisk } from "@/lib/types";
import type { BidAssistantState as AssistantState } from "@/lib/bid-simulation-history";
import { fmt, ppm2, signedMoney } from "@/components/bid-ceiling/assistant-state";
import { Field, MethodStep, Row } from "@/components/bid-ceiling/BidCeilingShared";

export function CeilingReferencePair({
  withoutWorks,
  withRefreshWorks,
  refreshWorksBudget,
  profileLabel,
}: {
  withoutWorks: MarketCeilingResult;
  withRefreshWorks: MarketCeilingResult;
  refreshWorksBudget: number;
  profileLabel: string;
}) {
  const rows = [
    {
      label: "Plafond selon vos hypothèses, sans travaux",
      result: withoutWorks,
      detail: `${profileLabel} · ${withoutWorks.safetyDiscountPct} % de marge`,
    },
    {
      label: "Même plafond avec un rafraîchissement",
      result: withRefreshWorks,
      detail: `${fmt(refreshWorksBudget)} de travaux · ${REFRESH_WORKS_PRICE_PER_M2} €/m²`,
    },
  ];

  return (
    <dl className="mt-5 grid gap-3 sm:grid-cols-2">
      {rows.map((row) => (
        <div key={row.label} className="rounded-lg border border-gold/20 bg-white/75 p-4">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-gold-text">
            {row.label}
          </dt>
          <dd className="mt-2 text-2xl font-semibold tabular-nums text-foreground">
            {row.result.available ? fmt(row.result.maxBid) : "À compléter"}
          </dd>
          <p className="mt-1 text-xs text-muted-foreground">{row.detail}</p>
        </div>
      ))}
      {withoutWorks.warning ? (
        <p
          role="note"
          className="rounded-lg border border-amber-300/50 bg-amber-50 px-3 py-2 text-xs font-medium leading-relaxed text-amber-800 sm:col-span-2"
        >
          {withoutWorks.warning}
        </p>
      ) : null}
      {withoutWorks.occupancy?.applied ? (
        <p
          role="note"
          className="rounded-lg border border-amber-300/50 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 sm:col-span-2"
        >
          <strong>
            {withoutWorks.occupancy.status === "unknown"
              ? "Occupation non confirmée, traitée comme un bien occupé"
              : "Bien occupé"}
            {" : "}plafond réduit de {fmt(withoutWorks.occupancy.bidReduction)}
          </strong>{" "}
          (décote de {withoutWorks.occupancy.discountPct} % sur la valeur
          {withoutWorks.occupancy.carryingCost > 0
            ? ` et ${fmt(withoutWorks.occupancy.carryingCost)} de portage`
            : ""}
          ). Ajustez ces hypothèses dans le détail des frais.
        </p>
      ) : null}
    </dl>
  );
}

/**
 * Visual range bar: where the prudent→offensif ceilings sit, where the selected
 * profile lands, and where the mise à prix stands relative to the range.
 */
export function RangeBar({
  minBid,
  maxBid,
  selectedBid,
  startingPrice,
  rangeLabel,
}: {
  minBid: number;
  maxBid: number;
  selectedBid: number;
  startingPrice: number;
  rangeLabel: string;
}) {
  // Scale with 12% padding on both sides so markers near the edges stay visible.
  const span = Math.max(1, maxBid - minBid);
  const lo = minBid - span * 0.12;
  const hi = maxBid + span * 0.12;
  const pct = (value: number) => Math.min(100, Math.max(0, ((value - lo) / (hi - lo)) * 100));
  const pos = (value: number) => `${pct(value)}%`;
  const startBelowRange = startingPrice > 0 && startingPrice < minBid;
  const startPct = pct(startingPrice);
  const startLabelClass =
    startPct <= 8 ? "translate-x-0" : startPct >= 92 ? "-translate-x-full" : "-translate-x-1/2";

  return (
    <div className="mt-6">
      <div className="flex items-baseline justify-between text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
        <span>Fourchette selon votre profil</span>
        <span className="tabular-nums">{rangeLabel}</span>
      </div>
      <div className="relative mt-6 h-2 rounded-full bg-white/8">
        <div
          className="absolute inset-y-0 rounded-full bg-gradient-to-r from-[var(--signal-opportunity)] via-gold to-[var(--signal-watch)]"
          style={{ left: pos(minBid), right: `calc(100% - ${pos(maxBid)})` }}
          aria-hidden
        />
        {/* Repère du profil sélectionné */}
        <span
          className="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-gold shadow-[0_0_0_3px_rgb(242_196_135/30%)]"
          style={{ left: pos(selectedBid) }}
          title={`Votre plafond : ${fmt(selectedBid)}`}
          aria-hidden
        />
        {/* Repère mise à prix */}
        {startingPrice > 0 && (
          <span
            className={`absolute -top-5 whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground ${startLabelClass}`}
            style={{ left: pos(startingPrice) }}
            aria-hidden
          >
            ▾ mise à prix
          </span>
        )}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
        <span>
          Prudent <strong className="tabular-nums text-foreground">{fmt(minBid)}</strong>
        </span>
        <span>
          Offensif <strong className="tabular-nums text-foreground">{fmt(maxBid)}</strong>
        </span>
      </div>
      {startBelowRange && (
        <p className="mt-3 text-xs leading-relaxed text-[var(--signal-opportunity)]">
          La mise à prix démarre sous votre fourchette : le dossier offre une vraie marge de
          manœuvre en salle.
        </p>
      )}
    </div>
  );
}

/** Single concrete next step before the hearing, derived from the dossier. */
export function buildNextAction(sale: AuctionSale, verdictAvailable: boolean): string {
  if (!verdictAvailable) {
    return "Renseignez le prix de marché local pour obtenir votre plafond.";
  }
  const occupancy = (sale.occupancy_status ?? "").toLowerCase();
  if (!sale.occupancy_status || occupancy === "unknown") {
    return "Confirmez l'occupation du bien (PV descriptif) avant de figer votre plafond.";
  }
  const risks = sale.risks ?? [];
  const worksRisk = risks.find((risk) =>
    `${risk.risk_label ?? ""} ${risk.risk_type ?? ""}`.toLowerCase().match(/travaux|renov/),
  );
  if (worksRisk) {
    return "Chiffrez les travaux et reportez-les dans les hypothèses pour affiner le plafond.";
  }
  if (collectSaleDocuments(sale).length > 0) {
    return "Relisez le cahier des conditions de vente avec ce plafond en tête.";
  }
  return "Visitez le bien si possible, puis validez votre plafond avant l'audience.";
}

export function AssistantHeader({ onReset }: { onReset: () => void }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-lg border border-gold/30 bg-gold/10 text-gold-text">
          <Calculator className="h-5 w-5" />
        </span>
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Assistant d'enchère
          </div>
          <h2 className="mt-1 font-sans text-lg font-semibold text-foreground">
            Déterminer une mise maximum défendable
          </h2>
        </div>
      </div>
      <button
        type="button"
        onClick={onReset}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        title="Réinitialiser"
      >
        <RotateCcw className="h-3.5 w-3.5" />
        Réinitialiser
      </button>
    </div>
  );
}

export function HypothesisEditor({
  state,
  startingPrice,
  result,
  onChange,
}: {
  state: AssistantState;
  startingPrice: number;
  result: MarketCeilingResult;
  onChange: Dispatch<SetStateAction<AssistantState>>;
}) {
  const defaultRatePct = Math.round(result.simulated.registrationRate * 10_000) / 100;
  const occupancy = result.occupancy;
  return (
    <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field
        label="Mise simulée"
        suffix="€"
        value={state.price}
        onChange={(price) => onChange((current) => ({ ...current, price }))}
        hint={`Mise à prix : ${formatPrice(startingPrice)}`}
      />
      <Field
        label="Frais préalables taxés"
        suffix="€"
        value={state.fpt}
        onChange={(fpt) => onChange((current) => ({ ...current, fpt }))}
        hint="Hypothèse ajustable"
      />
      <Field
        label="Honoraires de votre avocat (TTC)"
        suffix="€"
        value={state.lawyerFees ?? DEFAULTS.lawyerFees}
        onChange={(lawyerFees) => onChange((current) => ({ ...current, lawyerFees }))}
        hint="Hors émoluments tarifés. 1 500 € par défaut, à ajuster selon votre convention."
      />
      <Field
        label="Taux des droits de mutation"
        suffix="%"
        value={state.registrationRatePct ?? defaultRatePct}
        onChange={(registrationRatePct) =>
          onChange((current) => ({ ...current, registrationRatePct }))
        }
        hint={`Taux global au ${DMTO_TABLE_DATE} (${defaultRatePct.toLocaleString("fr-FR")} % retenu par défaut). Certains départements appliquent 5,81 %.`}
      />
      <label className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground sm:col-span-2">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={state.taxRegime === "vat"}
          onChange={(event) =>
            onChange((current) => ({
              ...current,
              taxRegime: event.target.checked ? "vat" : "registration",
            }))
          }
        />
        <span>
          Bien soumis à la TVA (terrain à bâtir, vendeur assujetti) : la TVA de 20 % sur le prix
          remplace les droits de mutation.
        </span>
      </label>
      {occupancy?.applied ? (
        <>
          <Field
            label="Décote d’occupation"
            suffix="%"
            value={state.occupancyDiscountPct ?? DEFAULTS.occupancyDiscountPct}
            onChange={(occupancyDiscountPct) =>
              onChange((current) => ({ ...current, occupancyDiscountPct }))
            }
            hint="Appliquée à la valeur de marché d’un bien occupé ou d’occupation non confirmée."
          />
          <Field
            label="Mois de portage avant libération"
            value={state.carryMonths ?? DEFAULTS.occupancyCarryMonths}
            onChange={(carryMonths) => onChange((current) => ({ ...current, carryMonths }))}
            hint="Durée estimée avant de pouvoir disposer du bien."
          />
          <Field
            label="Charges mensuelles à porter"
            suffix="€/mois"
            value={state.monthlyCarryCharges ?? 0}
            onChange={(monthlyCarryCharges) =>
              onChange((current) => ({ ...current, monthlyCarryCharges }))
            }
            hint="Charges de copropriété, taxe foncière, assurance : multipliées par les mois de portage."
          />
        </>
      ) : null}
    </div>
  );
}

export function SimulationCard({
  result,
  selectedMargin,
}: {
  result: MarketCeilingResult;
  selectedMargin: number | null;
}) {
  const positive = selectedMargin != null && selectedMargin >= 0;
  return (
    <div
      className={`rounded-lg border p-4 ${
        positive ? "border-emerald-300/20 bg-emerald-400/10" : "border-amber-300/25 bg-amber-400/10"
      }`}
    >
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        <TrendingDown className="h-4 w-4 text-gold-text" />
        Test de la mise simulée
      </div>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-3xl font-semibold tabular-nums text-foreground">
            {result.available ? fmt(result.simulated.totalCost) : "À compléter"}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            coût complet : enchère, frais, FPT et travaux
          </p>
        </div>
        <div className="text-right">
          <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            Marge restante
          </div>
          <div className="mt-1 text-xl font-semibold tabular-nums text-foreground">
            {selectedMargin == null ? "À compléter" : signedMoney(selectedMargin)}
          </div>
        </div>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        {result.available
          ? positive
            ? "La mise simulée reste dans la zone défendable du scénario sélectionné."
            : "La mise simulée dépasse la zone défendable : il faut baisser l'enchère ou justifier une meilleure hypothèse de marché."
          : "Ajoutez un prix de marché local pour savoir si la mise simulée reste défendable."}
      </p>
    </div>
  );
}

export function MethodCard({
  result,
  estimate,
}: {
  result: MarketCeilingResult;
  estimate: DvfMarketEstimate | null;
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/35 p-4">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-gold-text">
        <ShieldCheck className="h-4 w-4" />
        Raisonnement retenu
      </div>
      <ol className="mt-3 grid gap-2 text-sm leading-relaxed text-muted-foreground sm:grid-cols-3">
        <MethodStep
          index="1"
          title="Marché"
          text={
            result.available
              ? `${result.basisLabel} : ${ppm2(result.marketReferencePricePerM2)}.`
              : "Prix local à compléter."
          }
        />
        <MethodStep
          index="2"
          title="Marge"
          text={
            result.available
              ? `${result.safetyDiscountPct}% retirés pour rester sous le marché.`
              : "La marge évite d'acheter au prix d'une vente classique."
          }
        />
        <MethodStep
          index="3"
          title="Plafond"
          text={
            result.available
              ? `Frais et travaux déduits : ${fmt(result.maxBid)}.`
              : "Le plafond sort dès que le marché est connu."
          }
        />
      </ol>
      {estimate?.qualityWarnings?.length ? (
        <p className="mt-3 rounded-md border border-amber-300/40 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
          Prudence sur la référence locale : {estimate.qualityWarnings.join(", ")}.
        </p>
      ) : null}
    </div>
  );
}

export function SuccessConditions({
  sale,
  result,
  estimate,
  useManualMarket,
}: {
  sale: AuctionSale;
  result: MarketCeilingResult;
  estimate: DvfMarketEstimate | null;
  useManualMarket: boolean;
}) {
  const conditions = buildSuccessConditions(sale, result, estimate, useManualMarket);
  return (
    <div className="mt-5 rounded-lg border border-border bg-muted/35 p-4">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-gold-text">
        <CheckCircle2 className="h-4 w-4" />
        Conditions pour rester gagnant
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {conditions.map((condition) => (
          <div key={condition.title} className="rounded-lg border border-border bg-white p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <span className="text-gold-text">{condition.icon}</span>
              {condition.title}
            </div>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{condition.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function FeesBreakdown({
  result,
  fpt,
  onChange,
}: {
  result: MarketCeilingResult;
  fpt: number;
  onChange: Dispatch<SetStateAction<AssistantState>>;
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/35 p-4">
      <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        Frais retenus
      </div>
      <dl className="mt-3 grid gap-2 text-sm">
        <Row label="Émoluments avocat HT" value={fmt(result.simulated.emolumentsHT)} />
        <Row
          label="TVA sur émoluments"
          value={fmt(result.simulated.emolumentsTTC - result.simulated.emolumentsHT)}
        />
        {result.simulated.taxRegime === "vat" ? (
          <Row label="TVA sur le prix (20 %)" value={fmt(result.simulated.vatOnPrice)} />
        ) : (
          <>
            <Row
              label={`Droits de mutation (${(result.simulated.registrationRate * 100).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} %)`}
              value={fmt(result.simulated.registrationDuties)}
            />
            <Row label="Contribution de sécurité immobilière" value={fmt(result.simulated.csi)} />
          </>
        )}
        <Row label="Honoraires de votre avocat" value={fmt(result.simulated.lawyerFees)} />
        <Row
          label="FPT"
          value={fmt(result.simulated.fpt)}
          editable
          current={fpt}
          onEdit={(value) => onChange((current) => ({ ...current, fpt: value }))}
        />
        <Row label="Travaux" value={fmt(result.simulated.works)} />
        <Row
          label="Total frais hors travaux"
          value={fmt(result.simulated.acquisitionFeesTotal)}
          bold
        />
      </dl>
      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        Émoluments : barème au {EMOLUMENT_SCALE_DATE} ({EMOLUMENT_SCALE_REFERENCE}). Droits de
        mutation : taux départementaux au {DMTO_TABLE_DATE}, calculés sur le prix et les frais
        préalables.
      </p>
    </div>
  );
}

function buildSuccessConditions(
  sale: AuctionSale,
  result: MarketCeilingResult,
  estimate: DvfMarketEstimate | null,
  useManualMarket: boolean,
): Array<{ icon: ReactNode; title: string; text: string }> {
  const docs = collectSaleDocuments(sale);
  const risks = [...(sale.risks ?? [])].sort((a, b) => (b.severity ?? 0) - (a.severity ?? 0));
  const conditions: Array<{ icon: ReactNode; title: string; text: string }> = [
    {
      icon: <TrendingDown className="h-4 w-4" />,
      title: "Acheter sous le marché",
      text: result.available
        ? `Le scénario sélectionné vise un coût complet de ${ppm2(result.maxAllInPricePerM2)}, soit ${result.safetyDiscountPct}% sous la référence locale.`
        : "Le plafond deviendra exploitable dès qu'un prix de marché local sera renseigné.",
    },
    {
      icon: <FileSearch className="h-4 w-4" />,
      title: "Pièces à relire",
      text:
        docs.length > 0
          ? `${docs.length} pièce${docs.length > 1 ? "s" : ""} disponible${docs.length > 1 ? "s" : ""}. Les points importants doivent rester reliés à leur source.`
          : "Aucune pièce consultable n'est disponible : le plafond doit rester une hypothèse prudente.",
    },
    {
      icon: <Home className="h-4 w-4" />,
      title: "Occupation",
      text: occupationCondition(sale.occupancy_status),
    },
    {
      icon: <MapPin className="h-4 w-4" />,
      title: "Marché local",
      text:
        estimate && !useManualMarket
          ? `${marketReferenceConfidence(estimate).confidenceLabel} : ${estimate.sampleSize} ${
              estimate.comparableMode === "address_history"
                ? "ventes de l'adresse"
                : estimate.comparableMode === "unit_sales"
                  ? "ventes unitaires de stationnement"
                  : "ventes comparables"
            } retenues dans un rayon de ${estimate.radiusM} m.`
          : "Référence à compléter manuellement si les ventes DVF ne suffisent pas autour de l'adresse.",
    },
  ];

  for (const risk of risks.slice(0, 2)) {
    conditions.push(riskCondition(risk));
  }

  return conditions.slice(0, 6);
}

function occupationCondition(status: string | null | undefined): string {
  const label = occupancyLabel(status);
  const normalized = (status ?? "").toLowerCase();
  if (!status || normalized === "unknown" || normalized === "inconnu") {
    return "Statut à confirmer : le délai de libération doit être intégré avant de fixer la mise finale.";
  }
  if (normalized.includes("occup") || normalized.includes("lou") || normalized.includes("rent")) {
    return `${label} : l'intérêt du dossier dépend du bail, du loyer, du délai et du coût de sortie.`;
  }
  return `${label} : hypothèse favorable, à confirmer dans le PV descriptif ou les conditions de vente.`;
}

function riskCondition(risk: SaleRisk): { icon: ReactNode; title: string; text: string } {
  const label = risk.risk_label || risk.risk_type || "Point à intégrer";
  const normalized = label.toLowerCase();
  const proof = riskProof(risk);
  if (normalized.includes("travaux") || normalized.includes("renov")) {
    return {
      icon: <Wrench className="h-4 w-4" />,
      title: "Travaux à provisionner",
      text: `Le sujet doit être converti en budget travaux avant enchère${proof}.`,
    };
  }
  if (/plomb|amiante|dpe|termite|diagnostic/.test(normalized)) {
    return {
      icon: <ShieldCheck className="h-4 w-4" />,
      title: "Diagnostic à intégrer",
      text: `Le diagnostic ne bloque pas mécaniquement le projet : il sert à calibrer le coût, le délai et la négociation${proof}.`,
    };
  }
  if (normalized.includes("servitude")) {
    return {
      icon: <FileSearch className="h-4 w-4" />,
      title: "Usage à vérifier",
      text: `La servitude doit être traduite en impact concret sur l'usage ou la revente${proof}.`,
    };
  }
  if (normalized.includes("copro")) {
    return {
      icon: <Home className="h-4 w-4" />,
      title: "Copropriété à relire",
      text: `Charges, travaux votés et règlement doivent être intégrés au plafond${proof}.`,
    };
  }
  return {
    icon: <FileSearch className="h-4 w-4" />,
    title: label,
    text: `Point à traduire en hypothèse de prix avant de monter l'enchère${proof}.`,
  };
}

function riskProof(risk: SaleRisk): string {
  const occurrence = risk.occurrences?.[0];
  if (occurrence?.document_type) {
    return `, source : ${documentTypeLabel(occurrence.document_type)}`;
  }
  if (risk.evidence) return ", preuve disponible plus bas";
  return "";
}
