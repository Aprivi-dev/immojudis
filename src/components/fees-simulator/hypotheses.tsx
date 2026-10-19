"use client";

import { useId, type ReactNode } from "react";
import { DEFAULTS } from "@/lib/profitability";
import { FEES_SIMULATOR_DEPARTMENTS } from "./departments";
import { AmountField, Field, FIELD_CLASSES, euro } from "./fields";

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
        hint="Taux de 6,32 % appliqué sauf dans l’Indre ; certains départements sont à 5,81 % : vérifiez avec votre avocat."
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
