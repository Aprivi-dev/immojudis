"use client";

import { useId, useState, type ReactNode } from "react";
import type { CeilingHypotheses, OccupationCase } from "@/lib/bid-ceiling-engine";
import { consignationAmount, marginPctFor, targetYieldPct } from "@/lib/bid-ceiling-engine";
import type { CeilingUserChoices } from "@/lib/bid-ceiling-defaults";
import { consignationRuleOf, labelsOf } from "@/lib/fee-regime-definitions";
import { LazyRentSourceNotice } from "@/components/LazyRentSourceNotice";

type ChoicesUpdate = (change: (choices: CeilingUserChoices) => CeilingUserChoices) => void;
type NumberChoice = {
  [K in keyof CeilingUserChoices]-?: NonNullable<CeilingUserChoices[K]> extends number ? K : never;
}[keyof CeilingUserChoices];

const OCCUPATION_OPTIONS: Array<{ value: OccupationCase; label: string }> = [
  { value: "libre", label: "Libre" },
  { value: "occupe", label: "Occupé (saisi ou sans bail)" },
  { value: "loue", label: "Loué (bail en cours)" },
  { value: "squat", label: "Occupé sans droit ni titre" },
  { value: "inconnu", label: "Non confirmé" },
];

export function CeilingHypothesesPanel({
  id,
  hypotheses: h,
  choices,
  onChoicesChange,
}: {
  /** Identifiant du panneau, pour `aria-controls` du bouton qui l'ouvre. */
  id?: string;
  hypotheses: CeilingHypotheses;
  choices: CeilingUserChoices;
  onChoicesChange: ChoicesUpdate;
}) {
  const set = (field: NumberChoice, value: number | null) =>
    onChoicesChange((current) => ({ ...current, [field]: value }));
  const surface = h.surface ?? 0;
  const pricePerM2 = h.value.amount && surface ? Math.round(h.value.amount / surface) : null;
  // 0 n'est pas un prix : il revient à l'estimation, comme un champ vide.
  const manualPricePerM2 = (choices.manualPricePerM2 ?? 0) > 0 ? choices.manualPricePerM2! : null;
  const release =
    h.occupation.case === "occupe" ||
    h.occupation.case === "squat" ||
    h.occupation.case === "inconnu";
  const labels = labelsOf(h).planner;
  const notarial = h.regime?.kind === "notarial";
  const byOffers = labelsOf(h).byOffers;
  const registrationHint = notarial
    ? `Selon le département du bien. Les émoluments du notaire suivent le barème réglementé (${h.regime?.emolumentScale.reference}, relevé le ${h.regime?.emolumentScale.date} : à confirmer sur Légifrance).`
    : "Selon le département du bien. Les émoluments de l’avocat poursuivant suivent le barème réglementé.";

  return (
    <div id={id} className="mt-4 grid gap-5 rounded-lg border border-line bg-muted/30 p-4 sm:p-5">
      <Group title="Valeur et marge">
        <NumberField
          label="Prix au m² du bien"
          suffix="€/m²"
          value={manualPricePerM2 ?? pricePerM2}
          zeroMeansEmpty
          hint={
            manualPricePerM2 != null
              ? "Votre prix remplace l’estimation Immojudis."
              : h.value.source === "absente"
                ? "Aucune estimation exploitable : saisissez un prix de marché."
                : "Estimation Immojudis. Modifiez-la si vous connaissez mieux le secteur."
          }
          onChange={(value) => set("manualPricePerM2", value)}
        />
        <NumberField
          label={h.project === "revendre" ? "Marge de revente visée" : "Marge de sécurité"}
          suffix="%"
          value={marginPctFor(h)}
          hint="Remplace celle du profil choisi."
          onChange={(value) => set("customMarginPct", value)}
        />
      </Group>

      <Group title="Occupation">
        <label className="grid gap-1 text-sm">
          <span className="font-medium text-foreground">Situation du bien</span>
          <select
            value={h.occupation.case}
            onChange={(event) =>
              onChoicesChange((current) => ({
                ...current,
                occupation: event.target.value as OccupationCase,
              }))
            }
            className="min-h-11 rounded-lg border border-brand-navy/55 bg-white px-3"
          >
            {OCCUPATION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {/* « saisi » est un mot de la saisie immobilière : chez le notaire, un bien sans bail. */}
                {notarial && option.value === "occupe" ? "Occupé (sans bail)" : option.label}
              </option>
            ))}
          </select>
        </label>
        {release ? (
          <>
            <NumberField
              label="Délai pour libérer le bien"
              suffix="mois"
              value={h.occupation.releaseMonths}
              hint={
                notarial
                  ? "Hors vente judiciaire, il n’y a pas de titre d’expulsion automatique : délai et coût à confirmer."
                  : "Commandement, délais du juge, trêve hivernale : 6 à 18 mois en pratique."
              }
              onChange={(value) => set("releaseMonths", value)}
            />
            <NumberField
              label="Coût de la libération"
              suffix="€"
              value={h.occupation.releaseCost}
              hint="Commissaire de justice, serrurier, garde-meubles."
              onChange={(value) => set("releaseCost", value)}
            />
          </>
        ) : null}
        {h.occupation.case === "loue" && h.project !== "louer" ? (
          <NumberField
            label="Décote d’un bien loué"
            suffix="%"
            value={h.occupation.rentedDiscountPct}
            onChange={(value) => set("rentedDiscountPct", value)}
          />
        ) : null}
      </Group>

      <Group title="Frais de la vente">
        {labels.preliminaryLabel ? (
          <NumberField
            label={labels.preliminaryLabel}
            suffix="€"
            value={h.fees.fpt}
            hint={
              h.feesSource.fpt === "document"
                ? "Montant lu dans l’annonce."
                : h.feesSource.fpt === "saisie"
                  ? "Montant que vous avez saisi."
                  : "Valeur prudente par défaut : frais préalables à lire dans le cahier des conditions de vente. Saisissez le montant lu dans le cahier : il remplace la valeur par défaut et le poste n’est plus signalé comme estimé."
            }
            onChange={(value) => set("fpt", value)}
          />
        ) : null}
        {labels.lawyerLabel ? (
          <NumberField
            label={labels.lawyerLabel}
            suffix="€"
            value={h.fees.lawyerFees}
            onChange={(value) => set("lawyerFees", value)}
          />
        ) : null}
        {notarial && h.regime?.consignation ? (
          <NumberField
            label="Garantie à déposer"
            suffix="€"
            value={consignationAmount(h, consignationRuleOf(h))}
            hint={
              h.feesSource.consignation === "document"
                ? "Montant lu dans l’annonce."
                : h.feesSource.consignation === "saisie"
                  ? "Montant que vous avez saisi."
                  : "Valeur par défaut (20 % de la mise à prix) : montant à lire dans les conditions de la vente. Saisissez le montant lu : il remplace la valeur par défaut et le poste n’est plus signalé comme estimé."
            }
            onChange={(value) => set("consignation", value)}
          />
        ) : null}
        {byOffers ? (
          <>
            <NumberField
              label={labels.negotiationLabel ?? "Honoraires de négociation"}
              suffix="% du prix"
              step={0.1}
              value={Math.round((h.fees.negotiationFeeRate ?? 0) * 1000) / 10}
              hint={
                h.feesSource.negotiation === "document"
                  ? (h.fees.negotiationFeeRate ?? 0) > 0
                    ? "Taux lu dans l’annonce, à la charge de l’acquéreur."
                    : "À la charge du vendeur d’après l’annonce : rien n’est compté."
                  : h.feesSource.negotiation === "saisie"
                    ? "Taux que vous avez saisi."
                    : (h.fees.negotiationFeeRate ?? 0) > 0
                      ? "Taux lu dans l’annonce, mais le redevable n’est pas indiqué : par prudence, l’acquéreur est supposé payer. À confirmer dans les conditions de la vente. Saisissez le taux lu : il remplace cette valeur et le poste n’est plus signalé comme estimé."
                      : "Taux non indiqué dans l’annonce : aucun honoraire n’est compté. À confirmer dans les conditions de la vente. Saisissez le taux lu : il remplace cette valeur et le poste n’est plus signalé comme estimé."
              }
              onChange={(value) => set("negotiationFeeRatePct", value)}
            />
            <NumberField
              label={labels.advertisingLabel ?? "Frais de publicité"}
              suffix="€"
              value={h.fees.advertisingFees ?? 0}
              hint={
                h.feesSource.advertising === "document"
                  ? "Montant lu dans l’annonce."
                  : h.feesSource.advertising === "saisie"
                    ? "Montant que vous avez saisi."
                    : "Non indiqués dans l’annonce : 0 € est compté. À confirmer dans les conditions de la vente."
              }
              onChange={(value) => set("advertisingFees", value)}
            />
          </>
        ) : null}
        <NumberField
          label="Droits d’enregistrement"
          suffix="%"
          step={0.01}
          value={Math.round((h.fees.registrationRate ?? 0) * 10_000) / 100}
          hint={registrationHint}
          onChange={(value) => set("registrationRatePct", value)}
        />
      </Group>

      <Group title="Portage">
        <NumberField
          label="Charges de copropriété"
          suffix="€/mois"
          value={h.carrying.monthlyCharges}
          onChange={(value) => set("monthlyCharges", value)}
        />
        <NumberField
          label="Taxe foncière"
          suffix="€/an"
          value={h.carrying.annualPropertyTax}
          onChange={(value) => set("annualPropertyTax", value)}
        />
        <NumberField
          label="Coût de l’argent"
          suffix="%/an"
          step={0.1}
          value={h.carrying.financingRatePct}
          hint="Taux de votre crédit, ou rendement que vous renoncez à percevoir sur votre apport."
          onChange={(value) => set("financingRatePct", value)}
        />
      </Group>

      {h.project === "louer" ? (
        <Group title="Location">
          <NumberField
            label={rentFieldLabel(h)}
            suffix="€"
            value={h.rent.monthly}
            zeroMeansEmpty
            hint={rentFieldHint(h)}
            onChange={(value) => set("monthlyRent", value)}
          />
          <NumberField
            label="Charges récupérables comprises dans le loyer"
            suffix="€/mois"
            value={h.rent.recoverableCharges ?? null}
            zeroMeansEmpty
            hint={
              h.rent.reference?.source.startsWith("anil_")
                ? "Vide : le loyer d’annonce ANIL est compté charges comprises. Saisissez-les pour les retirer du loyer."
                : undefined
            }
            onChange={(value) => set("recoverableCharges", value)}
          />
          <NumberField
            label={`Rendement ${h.rent.chargesIncluded ? "brut visé, charges comprises" : "net visé"}`}
            suffix="%"
            step={0.1}
            value={targetYieldPct(h)}
            onChange={(value) => set("targetNetYieldPct", value)}
          />
        </Group>
      ) : null}

      {h.project === "revendre" ? (
        <Group title="Revente">
          <NumberField
            label="Frais de revente"
            suffix="%"
            step={0.5}
            value={h.resale.sellingCostsPct}
            hint="Agence et diagnostics. La fiscalité de la plus-value n’est pas déduite."
            onChange={(value) => set("sellingCostsPct", value)}
          />
        </Group>
      ) : null}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="grid gap-3 sm:grid-cols-2">
      <legend className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-gold-text">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

/**
 * Champ numérique à saisie locale : ce que l'utilisateur tape reste affiché tel quel (un champ vidé
 * reste vide, la valeur retenue apparaît en grisé) et n'est remplacé par la valeur retenue qu'à la
 * sortie du champ. Un champ vide, ou à 0 quand `zeroMeansEmpty`, revient à la valeur par défaut.
 */
function NumberField({
  label,
  suffix,
  value,
  hint,
  step = 1,
  zeroMeansEmpty = false,
  onChange,
}: {
  label: string;
  suffix: string;
  value: number | null;
  hint?: ReactNode;
  step?: number;
  zeroMeansEmpty?: boolean;
  onChange: (value: number | null) => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const [draft, setDraft] = useState<string | null>(null);
  // Un montant négatif est refusé : le message reste jusqu'à la prochaine saisie valide, au lieu
  // de ramener le champ à sa valeur par défaut sans rien dire.
  const [negative, setNegative] = useState(false);
  const commit = (raw: string) => {
    const number = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(number)) {
      setNegative(false);
      return onChange(null);
    }
    setNegative(number < 0);
    const clean = Math.max(0, number);
    onChange(zeroMeansEmpty && clean === 0 ? null : clean);
  };
  const leave = () => {
    if (draft != null) commit(draft);
    setDraft(null);
  };
  const describedBy = [hint ? hintId : null, negative ? errorId : null].filter(Boolean).join(" ");
  return (
    <div className="grid content-start gap-1 text-sm">
      <label htmlFor={id} className="font-medium text-foreground">
        {label}
        {/* L'unité fait partie du nom du champ : « Marge de sécurité (%) ». */}
        <span className="sr-only"> ({suffix})</span>
      </label>
      <div
        className={`flex items-center gap-2 rounded-lg border bg-white px-3 focus-within:border-gold-soft focus-within:ring-1 focus-within:ring-gold-soft ${
          negative ? "border-danger" : "border-brand-navy/55"
        }`}
      >
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={0}
          step={step}
          value={draft ?? value ?? ""}
          placeholder={value != null ? String(value) : undefined}
          aria-describedby={describedBy || undefined}
          aria-invalid={negative || undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            commit(event.target.value);
          }}
          onBlur={leave}
          onKeyDown={(event) => {
            if (event.key === "Enter") leave();
          }}
          className="min-h-11 w-full bg-transparent tabular-nums outline-none"
        />
        <span aria-hidden className="shrink-0 text-xs text-ink-soft">
          {suffix}
        </span>
      </div>
      {negative ? (
        <p id={errorId} role="alert" className="text-xs font-semibold leading-relaxed text-danger">
          Saisissez un montant positif.
        </p>
      ) : null}
      {hint ? (
        <div id={hintId} className="text-xs leading-relaxed text-ink-soft">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Le loyer prérempli de la carte de l'ANIL est un loyer d'annonce CHARGES COMPRISES : tant que
 * l'utilisateur ne saisit pas les charges récupérables, rien ne les en retire (le moteur ne déduit que
 * les charges non récupérables, en pourcentage du loyer). Le champ ne s'appelle « hors charges » que
 * pour un loyer saisi ou absent.
 */
function rentFieldLabel(h: CeilingHypotheses): string {
  if (h.rent.source !== "estime") return "Loyer mensuel hors charges";
  return h.rent.reference?.source.startsWith("anil_")
    ? "Loyer d’annonce estimé, charges comprises (le loyer hors charges est plus bas)"
    : "Loyer estimé du département";
}

function rentFieldHint(h: CeilingHypotheses): ReactNode {
  if (h.rent.source === "absent") {
    return "Aucun loyer de référence pour cette commune ni pour ce département : saisissez un loyer, sinon le plafond ne tient pas compte du rendement.";
  }
  if (h.rent.source !== "estime") return undefined;
  const reference = h.rent.reference;
  if (!reference?.source.startsWith("anil_")) {
    return "Ordre de grandeur du département : remplacez-le si vous connaissez le loyer réel.";
  }
  return (
    <div className="grid gap-1">
      <p>
        Estimation du loyer d’annonce de la commune
        {reference.reliability === "reliable" ? "" : " (fiabilité indicative)"}, non constaté et non
        garanti. Remplacez-le par le loyer réel si vous le connaissez.
      </p>
      <LazyRentSourceNotice reference={reference} className="text-xs leading-relaxed" />
    </div>
  );
}
