"use client";

import { useId, type ReactNode } from "react";
import {
  DEFAULTS,
  DMTO_DEFAULT_RATE,
  DMTO_RATE_BY_DEPARTMENT,
  DMTO_RATE_REDUCED_DEPARTMENT,
  DMTO_RATE_UNCHANGED_DEPARTMENT,
  DMTO_TABLE_DATE,
  DMTO_TEMPORARY_INCREASE_END,
} from "@/lib/profitability";
import { FEES_SIMULATOR_DEPARTMENTS } from "./departments";
import { AmountField, Field, FIELD_CLASSES, euro } from "./fields";

/** « 6,32 % » : un taux de droits de mutation (fraction) écrit à la française. */
const dutyRate = (rate: number) =>
  `${(rate * 100).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;

/** Les codes des départements restés à 4,50 % de part départementale, pour le texte d'aide. */
const UNCHANGED_DEPARTMENTS = Object.entries(DMTO_RATE_BY_DEPARTMENT)
  .filter(([, rate]) => rate === DMTO_RATE_UNCHANGED_DEPARTMENT)
  .map(([code]) => code)
  .sort();

/**
 * Texte d'aide du département. Les taux viennent de `profitability.ts` (source et date y sont
 * écrites) ; la hausse à 5 % y est dite temporaire et sans effet pour un primo-accédant.
 */
const DEPARTMENT_HINT = `Taux de ${dutyRate(DMTO_DEFAULT_RATE)} par défaut. ${UNCHANGED_DEPARTMENTS.length} départements (${UNCHANGED_DEPARTMENTS.slice(0, -1).join(", ")} et ${UNCHANGED_DEPARTMENTS.at(-1)}) restent à ${dutyRate(DMTO_RATE_UNCHANGED_DEPARTMENT)}, et l’Indre est à ${dutyRate(DMTO_RATE_REDUCED_DEPARTMENT)} (tableau DGFiP au ${DMTO_TABLE_DATE}). La hausse à 5 % de la part départementale est temporaire (actes passés jusqu’au ${DMTO_TEMPORARY_INCREASE_END}) et ne s’applique pas aux primo-accédants d’une résidence principale : vérifiez le taux avec votre avocat.`;

/** Hypothèses de frais communes aux deux sens du calcul (valeurs saisies, telles quelles). */
export type Hypotheses = {
  department: string;
  fpt: string;
  lawyerFees: string;
  works: string;
};

export const DEFAULT_HYPOTHESES: Hypotheses = {
  department: "",
  // Valeurs d'exemple : le montant réel figure dans le cahier des conditions de vente.
  fpt: String(DEFAULTS.fpt),
  lawyerFees: String(DEFAULTS.lawyerFees),
  works: "0",
};

/**
 * Le champ de tête du mode (prix d'adjudication, ou budget total), puis les mêmes hypothèses de
 * frais dans le même ordre : département, frais préalables, honoraires, travaux.
 */
export function HypothesesFields({
  lead,
  values,
  onChange,
}: {
  lead: ReactNode;
  values: Hypotheses;
  onChange: (key: keyof Hypotheses, value: string) => void;
}) {
  const departmentId = useId();
  return (
    <>
      {lead}
      <Field
        label="Département du bien"
        htmlFor={departmentId}
        hintId={`${departmentId}-hint`}
        hint={DEPARTMENT_HINT}
      >
        <select
          id={departmentId}
          aria-describedby={`${departmentId}-hint`}
          value={values.department}
          onChange={(event) => onChange("department", event.target.value)}
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
        value={values.fpt}
        onChange={(value) => onChange("fpt", value)}
      />
      <AmountField
        label="Honoraires de l’avocat enchérisseur"
        hint={`Valeur d’exemple (${euro.format(DEFAULTS.lawyerFees)}) : remplacez-la par le montant convenu avec votre avocat, TTC.`}
        value={values.lawyerFees}
        onChange={(value) => onChange("lawyerFees", value)}
      />
      <AmountField
        label="Travaux"
        hint="Votre budget de travaux, s’il y en a."
        value={values.works}
        onChange={(value) => onChange("works", value)}
      />
    </>
  );
}
