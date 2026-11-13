"use client";

import { useId, type ReactNode } from "react";
import { DEFAULTS } from "@/lib/profitability";
import { FEES_SIMULATOR_DEPARTMENTS } from "./departments";
import { formatPriceWithCents } from "@/lib/format/numbers";
import { AmountField, Field, FIELD_CLASSES } from "./fields";

// Texte figé, pour ne pas embarquer côté client le calcul d'un libellé à partir du tableau DMTO ;
// FeesSimulator.test.tsx vérifie qu'il reste aligné sur `DMTO_RATE_BY_DEPARTMENT` (profitability.ts).
const DEPARTMENT_HINT =
  "Taux de 6,32 % par défaut. 11 départements (05, 06, 07, 16, 26, 48, 60, 65, 71, 971 et 976) restent à 5,81 %, et l’Indre est à 5,09 % (tableau DGFiP au 01/06/2026). La hausse à 5 % de la part départementale est temporaire (actes passés jusqu’au 31/03/2028) et ne s’applique pas aux primo-accédants d’une résidence principale : vérifiez le taux avec votre avocat.";

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
        hint={`Valeur d’exemple (${formatPriceWithCents(DEFAULTS.fpt)}) : remplacez-la par le montant indiqué dans le cahier des conditions de vente.`}
        value={values.fpt}
        onChange={(value) => onChange("fpt", value)}
      />
      <AmountField
        label="Honoraires de l’avocat enchérisseur"
        hint={`Valeur d’exemple (${formatPriceWithCents(DEFAULTS.lawyerFees)}) : remplacez-la par le montant convenu avec votre avocat, TTC.`}
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
