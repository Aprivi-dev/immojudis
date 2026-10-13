"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import { Card } from "@/components/ui/primitives";
import { computeAcquisitionCosts, DEFAULTS, DMTO_TABLE_DATE } from "@/lib/profitability";
import { FEES_SIMULATOR_DEPARTMENTS } from "./departments";
import { formatScaleDate } from "./scale-date";

export const DEFAULT_SIMULATOR_PRICE = 100_000;

const euro = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const percent = new Intl.NumberFormat("fr-FR", {
  style: "percent",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const FIELD_CLASSES =
  "min-h-11 w-full min-w-0 rounded-lg border border-line bg-white px-3 text-base tabular-nums focus-visible:border-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40";

/** Un champ vide vaut 0 dans le calcul, mais reste vide à l'écran. */
function toAmount(raw: string): number {
  if (raw.trim() === "") return 0;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function Field({
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

function AmountField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
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

export function FeesSimulator() {
  const [price, setPrice] = useState(String(DEFAULT_SIMULATOR_PRICE));
  const [department, setDepartment] = useState("");
  // Valeurs d'exemple : le montant réel figure dans le cahier des conditions de vente.
  const [fpt, setFpt] = useState(String(DEFAULTS.fpt));
  const [lawyerFees, setLawyerFees] = useState(String(DEFAULTS.lawyerFees));
  const [works, setWorks] = useState("0");
  const departmentId = useId();

  const costs = useMemo(
    () =>
      computeAcquisitionCosts({
        price: toAmount(price),
        fpt: toAmount(fpt),
        lawyerFees: toAmount(lawyerFees),
        works: toAmount(works),
        department: department || null,
      }),
    [price, fpt, lawyerFees, works, department],
  );

  return (
    <div className="grid min-w-0 gap-6 md:grid-cols-2">
      <Card as="section" aria-labelledby="simulateur-hypotheses" className="min-w-0">
        <h2 id="simulateur-hypotheses" className="font-display text-2xl font-semibold">
          Vos hypothèses
        </h2>
        <form
          className="mt-4 grid gap-4"
          onSubmit={(event) => event.preventDefault()}
          aria-label="Hypothèses du simulateur de frais"
        >
          <AmountField
            label="Prix d’adjudication"
            hint="Le prix auquel le bien est adjugé, hors frais."
            value={price}
            onChange={setPrice}
          />
          <Field
            label="Département du bien"
            htmlFor={departmentId}
            hintId={`${departmentId}-hint`}
            hint="Taux de 6,32 % appliqué sauf dans l’Indre ; certains départements sont à 5,81 % : vérifiez avec votre avocat."
          >
            <select
              id={departmentId}
              aria-describedby={`${departmentId}-hint`}
              value={department}
              onChange={(event) => setDepartment(event.target.value)}
              className={FIELD_CLASSES}
            >
              <option value="">Non précisé (taux par défaut)</option>
              {FEES_SIMULATOR_DEPARTMENTS.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.code} – {item.name}
                </option>
              ))}
            </select>
          </Field>
          <AmountField
            label="Frais préalables de la procédure"
            hint={`Valeur d’exemple (${euro.format(DEFAULTS.fpt)}) : remplacez-la par le montant indiqué dans le cahier des conditions de vente.`}
            value={fpt}
            onChange={setFpt}
          />
          <AmountField
            label="Honoraires de l’avocat enchérisseur"
            hint={`Valeur d’exemple (${euro.format(DEFAULTS.lawyerFees)}) : remplacez-la par le montant convenu avec votre avocat, TTC.`}
            value={lawyerFees}
            onChange={setLawyerFees}
          />
          <AmountField
            label="Travaux"
            hint="Votre budget de travaux, s’il y en a."
            value={works}
            onChange={setWorks}
          />
        </form>
      </Card>

      <Card as="section" aria-labelledby="simulateur-resultat" className="min-w-0 bg-surface-muted">
        <h2 id="simulateur-resultat" className="font-display text-2xl font-semibold">
          Détail du coût
        </h2>
        <dl className="mt-4 divide-y divide-line text-sm">
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
        <div className="mt-4 rounded-lg border border-gold/40 bg-white p-4">
          <p className="text-sm font-semibold">Coût total</p>
          <p
            aria-live="polite"
            aria-atomic="true"
            className="mt-1 break-words font-display text-3xl font-semibold tabular-nums"
          >
            {euro.format(costs.totalCost)}
          </p>
          {costs.price > 0 ? (
            <p className="mt-1 text-sm text-ink-soft">
              dont {euro.format(costs.acquisitionFeesTotal)} de frais d’acquisition, soit{" "}
              {costs.acquisitionFeesPct.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} % du
              prix d’adjudication.
            </p>
          ) : (
            <p className="mt-1 text-sm text-ink-soft">
              Saisissez un prix d’adjudication pour chiffrer les frais.
            </p>
          )}
          <p className="mt-2 text-xs leading-relaxed text-ink-soft">
            Hors travaux saisis ci-dessus, le financement et le portage (intérêts, taxe foncière,
            charges tant que le bien ne rapporte rien) ne sont pas inclus.
          </p>
        </div>
      </Card>
    </div>
  );
}
