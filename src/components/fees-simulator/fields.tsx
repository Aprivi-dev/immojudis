"use client";

import { useId, type ReactNode } from "react";
import { DMTO_TABLE_DATE, type AcquisitionCostResult } from "@/lib/profitability";
import { formatScaleDate } from "./scale-date";

export const euro = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Un prix d'adjudication maximal est un nombre entier d'euros. */
export const euroWhole = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const percent = new Intl.NumberFormat("fr-FR", {
  style: "percent",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export const FIELD_CLASSES =
  "min-h-11 w-full min-w-0 rounded-lg border border-line bg-white px-3 text-base tabular-nums focus-visible:border-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40";

/** Un champ vide vaut 0 dans le calcul, mais reste vide à l'écran. */
export function toAmount(raw: string): number {
  if (raw.trim() === "") return 0;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
  hintId,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  htmlFor: string;
  hintId?: string;
}) {
  return (
    <div className="grid min-w-0 content-start gap-1">
      <label htmlFor={htmlFor} className="text-sm font-semibold">
        {label}
      </label>
      {children}
      {hint ? (
        <p id={hintId} className="text-xs leading-relaxed text-ink-soft">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function AmountField({
  label,
  hint,
  value,
  onChange,
  max,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  /** Plafond du montant, relayé à l'attribut `max` de l'input. */
  max?: number;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <Field label={label} hint={hint} htmlFor={id} hintId={hintId}>
      <div className="flex min-w-0 items-center gap-2">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={0}
          max={max}
          step="any"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={hint ? hintId : undefined}
          className={FIELD_CLASSES}
        />
        <span aria-hidden className="shrink-0 text-sm text-ink-soft">
          €
        </span>
      </div>
    </Field>
  );
}

function Line({ label, detail, value }: { label: string; detail?: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <dt className="min-w-0 break-words">
        {label}
        {detail ? <span className="block text-xs text-ink-soft">{detail}</span> : null}
      </dt>
      <dd className="shrink-0 font-semibold tabular-nums">{euro.format(value)}</dd>
    </div>
  );
}

/** Détail des frais, identique dans tous les modes : il vient toujours du moteur de frais. */
export function CostLines({ costs }: { costs: AcquisitionCostResult }) {
  return (
    <dl className="divide-y divide-line text-sm">
      <Line label="Prix d’adjudication" value={costs.price} />
      <Line
        label="Émoluments proportionnels de vente, TTC (avocat poursuivant : 3/4 ; avocat de l’adjudicataire : 1/4)"
        detail={`HT : ${euro.format(costs.emolumentsHT)}`}
        value={costs.emolumentsTTC}
      />
      <Line
        label="Droits de mutation"
        detail={`Taux de ${percent.format(costs.registrationRate)} (tableau au ${formatScaleDate(DMTO_TABLE_DATE)})`}
        value={costs.registrationDuties}
      />
      <Line label="Contribution de sécurité immobilière" value={costs.csi} />
      <Line label="Frais préalables de la procédure" value={costs.fpt} />
      <Line label="Honoraires de l’avocat enchérisseur" value={costs.lawyerFees} />
      <Line label="Travaux" value={costs.works} />
    </dl>
  );
}
