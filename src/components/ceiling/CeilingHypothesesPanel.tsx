"use client";

import { useId, useState } from "react";
import type { CeilingHypotheses, OccupationCase } from "@/lib/bid-ceiling-engine";
import { marginPctFor, targetYieldPct } from "@/lib/bid-ceiling-engine";
import type { CeilingUserChoices } from "@/lib/bid-ceiling-defaults";

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
  hypotheses: h,
  choices,
  onChoicesChange,
}: {
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

  return (
    <div className="mt-4 grid gap-5 rounded-lg border border-border bg-muted/30 p-4 sm:p-5">
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
            className="min-h-11 rounded-lg border border-border bg-white px-3"
          >
            {OCCUPATION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
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
              hint="Commandement, délais du juge, trêve hivernale : 6 à 18 mois en pratique."
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
        <NumberField
          label="Frais préalables"
          suffix="€"
          value={h.fees.fpt}
          hint={
            h.feesSource.fpt === "document"
              ? "Montant lu dans l’annonce."
              : h.feesSource.fpt === "saisie"
                ? "Montant que vous avez saisi."
                : "Valeur prudente par défaut : frais préalables à lire dans le cahier des conditions de vente."
          }
          onChange={(value) => set("fpt", value)}
        />
        <NumberField
          label="Honoraires de votre avocat"
          suffix="€"
          value={h.fees.lawyerFees}
          onChange={(value) => set("lawyerFees", value)}
        />
        <NumberField
          label="Droits d’enregistrement"
          suffix="%"
          step={0.01}
          value={Math.round((h.fees.registrationRate ?? 0) * 10_000) / 100}
          hint="Selon le département du bien. Les émoluments de l’avocat poursuivant suivent le barème réglementé."
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
            label="Loyer mensuel hors charges"
            suffix="€"
            value={h.rent.monthly}
            zeroMeansEmpty
            hint={
              h.rent.source === "estime"
                ? "Loyer de référence du département. Remplacez-le si vous connaissez le loyer réel."
                : h.rent.source === "absent"
                  ? "Aucun loyer de référence pour ce département : saisissez un loyer, sinon le plafond ne tient pas compte du rendement."
                  : undefined
            }
            onChange={(value) => set("monthlyRent", value)}
          />
          <NumberField
            label="Rendement net visé"
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
  hint?: string;
  step?: number;
  zeroMeansEmpty?: boolean;
  onChange: (value: number | null) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (raw: string) => {
    const number = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(number)) return onChange(null);
    const clean = Math.max(0, number);
    onChange(zeroMeansEmpty && clean === 0 ? null : clean);
  };
  const leave = () => {
    if (draft != null) commit(draft);
    setDraft(null);
  };
  return (
    <div className="grid content-start gap-1 text-sm">
      <label htmlFor={id} className="font-medium text-foreground">
        {label}
      </label>
      <div className="flex items-center gap-2 rounded-lg border border-border bg-white px-3 focus-within:border-gold">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={0}
          step={step}
          value={draft ?? value ?? ""}
          placeholder={value != null ? String(value) : undefined}
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
        <span className="shrink-0 text-xs text-muted-foreground">{suffix}</span>
      </div>
      {hint ? <span className="text-xs leading-relaxed text-muted-foreground">{hint}</span> : null}
    </div>
  );
}
