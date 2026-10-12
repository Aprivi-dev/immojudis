"use client";

import { useId, useState } from "react";
import { formatPrice } from "@/lib/format";
import {
  calculateReportRentalScenario,
  REPORT_RENTAL_EXPENSE_FIELDS,
  REPORT_RENTAL_EXPENSE_FIELD_LABELS,
} from "@/lib/report-simulation";
import styles from "./ListingRental.module.css";

export type ListingRentalDraft = {
  monthlyRent: string;
  vacancyRatePct: string;
  annualNonRecoverableCharges: string;
  annualPropertyTax: string;
  annualLandlordInsurance: string;
};

export const EMPTY_LISTING_RENTAL_DRAFT: ListingRentalDraft = {
  monthlyRent: "",
  vacancyRatePct: "",
  annualNonRecoverableCharges: "",
  annualPropertyTax: "",
  annualLandlordInsurance: "",
};

export type RentalScenarioInputs = {
  acquisitionCost: number;
  monthlyRent: number;
  vacancyRatePct: number;
  annualNonRecoverableCharges: number;
  annualPropertyTax: number;
  annualLandlordInsurance: number;
  monthlyDebtService?: number | null;
};

export type RentalScenarioResult = {
  annualPotentialRent: number;
  annualEffectiveRent: number;
  annualOperatingIncome: number;
  grossYieldPct: number;
  netOperatingYieldPct: number;
  monthlyCashFlow: number | null;
};

export type ListingRentalProps = {
  /** The complete project cost used as the denominator for the yields. */
  acquisitionCost: number | null;
  /** The known monthly principal/interest payment, when a financing scenario exists. */
  monthlyDebtService?: number | null;
  /** Keeps labels and form ids unique when several listings are rendered together. */
  saleId: string;
  /** Values captured by a parent so a tab switch does not lose the scenario. */
  initialDraft?: Partial<ListingRentalDraft> | null;
  onDraftChange?: (draft: ListingRentalDraft) => void;
};

const FIELD_LABELS: Record<keyof ListingRentalDraft, string> = {
  monthlyRent: "Loyer mensuel hors charges",
  vacancyRatePct: "Vacance locative",
  annualNonRecoverableCharges: "Charges non récupérables / an",
  annualPropertyTax: "Taxe foncière / an",
  annualLandlordInsurance: "Assurance propriétaire / an",
};

function parseInput(value: string): number | null {
  const normalized = value
    .trim()
    .replace(/[\s\u00a0\u202f]/g, "")
    .replace(",", ".");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeInitialDraft(
  initialDraft?: Partial<ListingRentalDraft> | null,
): ListingRentalDraft {
  return {
    ...EMPTY_LISTING_RENTAL_DRAFT,
    ...initialDraft,
  };
}

/**
 * Calculates a rental scenario without applying a tax rate or an unverified
 * market rent. The denominator is the user's supplied complete project cost.
 */
export function calculateRentalScenario(inputs: RentalScenarioInputs): RentalScenarioResult | null {
  return calculateReportRentalScenario({
    ...inputs,
    monthlyDebtService: inputs.monthlyDebtService ?? null,
    missingExpenseFields: [],
  });
}

function formatYield(value: number): string {
  return `${new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  }).format(value)} %`;
}

function formatInputValue(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "" : String(value);
}

function getFieldError(field: keyof ListingRentalDraft, value: string): string | null {
  const parsed = parseInput(value);
  if (!value.trim()) return null;
  if (parsed == null) return "Saisissez un nombre valide.";
  if (parsed < 0) return "La valeur ne peut pas être négative.";
  if (field === "monthlyRent" && parsed === 0) return "Le loyer doit être supérieur à 0 €.";
  if (field === "vacancyRatePct" && parsed > 100) return "La vacance doit rester entre 0 et 100 %.";
  return null;
}

function displayAmount(value: string): number | null {
  const parsed = parseInput(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

export function ListingRental({
  acquisitionCost,
  monthlyDebtService = null,
  saleId,
  initialDraft,
  onDraftChange,
}: ListingRentalProps) {
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const componentId = `listing-rental-${saleId.replace(/[^a-zA-Z0-9_-]/g, "")}-${reactId}`;
  const [draft, setDraft] = useState<ListingRentalDraft>(() => normalizeInitialDraft(initialDraft));

  const acquisitionCostIsValid = positiveNumber(acquisitionCost) != null;
  const parsedRent = parseInput(draft.monthlyRent);
  const parsedVacancy = parseInput(draft.vacancyRatePct);
  const missingExpenseFields = REPORT_RENTAL_EXPENSE_FIELDS.filter((field) => !draft[field].trim());
  const hasInvalidField = (Object.keys(draft) as Array<keyof ListingRentalDraft>).some(
    (field) => getFieldError(field, draft[field]) != null,
  );
  const rentalResult =
    acquisitionCostIsValid &&
    !hasInvalidField &&
    parsedRent != null &&
    parsedRent > 0 &&
    parsedVacancy != null &&
    parsedVacancy >= 0 &&
    parsedVacancy <= 100
      ? calculateRentalScenario({
          acquisitionCost: acquisitionCost as number,
          monthlyRent: parsedRent,
          vacancyRatePct: parsedVacancy,
          annualNonRecoverableCharges: displayAmount(draft.annualNonRecoverableCharges) ?? 0,
          annualPropertyTax: displayAmount(draft.annualPropertyTax) ?? 0,
          annualLandlordInsurance: displayAmount(draft.annualLandlordInsurance) ?? 0,
          monthlyDebtService,
        })
      : null;

  const updateField = (field: keyof ListingRentalDraft, value: string) => {
    const nextDraft = { ...draft, [field]: value };
    setDraft(nextDraft);
    onDraftChange?.(nextDraft);
  };

  const ids = {
    rent: `${componentId}-rent`,
    vacancy: `${componentId}-vacancy`,
    charges: `${componentId}-charges`,
    propertyTax: `${componentId}-property-tax`,
    insurance: `${componentId}-insurance`,
    acquisitionHelp: `${componentId}-acquisition-help`,
    rentHelp: `${componentId}-rent-help`,
    vacancyHelp: `${componentId}-vacancy-help`,
    chargesHelp: `${componentId}-charges-help`,
    propertyTaxHelp: `${componentId}-property-tax-help`,
    insuranceHelp: `${componentId}-insurance-help`,
  };

  const fields: Array<{
    key: keyof ListingRentalDraft;
    id: string;
    helpId: string;
    suffix: string;
    inputMode: "decimal";
    placeholder: string;
  }> = [
    {
      key: "monthlyRent",
      id: ids.rent,
      helpId: ids.rentHelp,
      suffix: "€/mois",
      inputMode: "decimal",
      placeholder: "À renseigner",
    },
    {
      key: "vacancyRatePct",
      id: ids.vacancy,
      helpId: ids.vacancyHelp,
      suffix: "%",
      inputMode: "decimal",
      placeholder: "À renseigner",
    },
    {
      key: "annualNonRecoverableCharges",
      id: ids.charges,
      helpId: ids.chargesHelp,
      suffix: "€/an",
      inputMode: "decimal",
      placeholder: "À renseigner",
    },
    {
      key: "annualPropertyTax",
      id: ids.propertyTax,
      helpId: ids.propertyTaxHelp,
      suffix: "€/an",
      inputMode: "decimal",
      placeholder: "À renseigner",
    },
    {
      key: "annualLandlordInsurance",
      id: ids.insurance,
      helpId: ids.insuranceHelp,
      suffix: "€/an",
      inputMode: "decimal",
      placeholder: "À renseigner",
    },
  ];

  return (
    <section className={styles.section} aria-labelledby={`${componentId}-title`}>
      <div className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Projection locative</p>
          <h2 id={`${componentId}-title`} className={styles.title}>
            Tester le scénario de location
          </h2>
          <p className={styles.subtitle}>
            Saisissez vos propres hypothèses pour mesurer le rendement du coût complet du projet.
          </p>
        </div>
        <span className={styles.badge}>Simulation personnelle</span>
      </div>

      <div className={styles.content}>
        <form className={styles.inputPanel} onSubmit={(event) => event.preventDefault()} noValidate>
          <fieldset className={styles.fieldset}>
            <legend className={styles.panelTitle}>Vos hypothèses</legend>
            <p className={styles.panelIntro}>
              Aucun loyer n&apos;est prérempli. Les montants sont vos données de scénario.
            </p>

            <div className={styles.costReference} aria-describedby={ids.acquisitionHelp}>
              <span>Coût complet retenu</span>
              <strong>{formatPrice(acquisitionCost)}</strong>
              <p id={ids.acquisitionHelp}>
                Le rendement est rapporté au coût complet fourni par l&apos;annonce ou votre
                scénario.
              </p>
            </div>

            <div className={styles.fields}>
              {fields.map(({ key, id, helpId, suffix, inputMode, placeholder }) => {
                const error = getFieldError(key, draft[key]);
                const isRent = key === "monthlyRent";
                const isVacancy = key === "vacancyRatePct";
                return (
                  <div className={styles.field} key={key}>
                    <label htmlFor={id}>
                      {FIELD_LABELS[key]} {isRent ? <span aria-hidden="true">*</span> : null}
                    </label>
                    <div className={styles.inputWithSuffix}>
                      <input
                        id={id}
                        type="number"
                        min="0"
                        max={isVacancy ? "100" : undefined}
                        step="0.01"
                        inputMode={inputMode}
                        value={draft[key]}
                        onChange={(event) => updateField(key, event.currentTarget.value)}
                        placeholder={placeholder}
                        aria-invalid={error ? "true" : undefined}
                        aria-describedby={error ? helpId : undefined}
                      />
                      <span aria-hidden="true">{suffix}</span>
                    </div>
                    {error ? (
                      <p id={helpId} className={styles.error} role="alert">
                        {error}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {!acquisitionCostIsValid ? (
              <p className={styles.warning} role="status">
                Le coût complet doit être renseigné avant de calculer un rendement.
              </p>
            ) : null}
            <p className={styles.note}>
              Les postes de charges laissés vides sont comptés à 0 € dans cette simulation. Vérifiez
              le dossier avant de retenir ce scénario.
            </p>
          </fieldset>
        </form>

        <aside className={styles.resultPanel} aria-labelledby={`${componentId}-results-title`}>
          <p className={styles.panelKicker}>Lecture du scénario</p>
          <h3 id={`${componentId}-results-title`} className={styles.resultTitle}>
            Vos repères locatifs
          </h3>
          <p className={styles.panelIntro}>
            Les résultats s&apos;activent quand le loyer, la vacance et le coût complet sont connus.
          </p>

          {rentalResult ? (
            <div className={styles.resultStack} role="status" aria-live="polite" aria-atomic="true">
              {missingExpenseFields.length ? (
                <p className={styles.warning}>
                  <strong>Scénario incomplet</strong>:{" "}
                  {missingExpenseFields
                    .map((field) => REPORT_RENTAL_EXPENSE_FIELD_LABELS[field])
                    .join(", ")}{" "}
                  laissés vides et comptés à 0 € pour ce calcul.
                </p>
              ) : null}
              <div className={`${styles.resultCard} ${styles.primaryResult}`}>
                <span>Rendement brut</span>
                <strong>{formatYield(rentalResult.grossYieldPct)}</strong>
                <small>
                  {formatPrice(Math.round(rentalResult.annualPotentialRent))} de loyers / an
                </small>
              </div>
              <div className={styles.resultGrid}>
                <div className={styles.resultCard}>
                  <span>Revenu net d&apos;exploitation</span>
                  <strong>{formatPrice(Math.round(rentalResult.annualOperatingIncome))}</strong>
                  <small>avant impôts · par an</small>
                </div>
                <div className={styles.resultCard}>
                  <span>Rendement net d&apos;exploitation</span>
                  <strong>{formatYield(rentalResult.netOperatingYieldPct)}</strong>
                  <small>après vacance et charges saisies</small>
                </div>
              </div>
              {rentalResult.monthlyCashFlow != null ? (
                <div className={`${styles.resultCard} ${styles.cashFlowResult}`}>
                  <span>Cash-flow mensuel avant impôts</span>
                  <strong>{formatPrice(Math.round(rentalResult.monthlyCashFlow))}</strong>
                  <small>
                    après mensualité de crédit · {formatPrice(Math.round(monthlyDebtService ?? 0))}{" "}
                    / mois
                  </small>
                </div>
              ) : (
                <p className={styles.missingResult}>
                  Ajoutez une mensualité de crédit pour afficher le cash-flow mensuel.
                </p>
              )}
            </div>
          ) : (
            <div className={styles.emptyResult} role="status" aria-live="polite">
              <strong>Scénario à compléter</strong>
              <p>
                Le rendement brut apparaîtra après la saisie d&apos;un loyer mensuel et d&apos;une
                vacance.
              </p>
              <span>Le calcul ne remplace ni un devis, ni une validation fiscale ou bancaire.</span>
            </div>
          )}

          <details className={styles.method}>
            <summary>Voir les formules</summary>
            <ul>
              <li>Brut = loyer mensuel × 12 ÷ coût complet.</li>
              <li>
                Net avant impôts = loyers après vacance − charges − taxe foncière − assurance.
              </li>
              <li>Cash-flow = net avant impôts ÷ 12 − mensualité saisie.</li>
            </ul>
          </details>
        </aside>
      </div>
    </section>
  );
}

export function rentalDraftFromValues(values: {
  monthlyRent?: number | null;
  vacancyRatePct?: number | null;
  annualNonRecoverableCharges?: number | null;
  annualPropertyTax?: number | null;
  annualLandlordInsurance?: number | null;
}): ListingRentalDraft {
  return {
    monthlyRent: formatInputValue(values.monthlyRent),
    vacancyRatePct: formatInputValue(values.vacancyRatePct),
    annualNonRecoverableCharges: formatInputValue(values.annualNonRecoverableCharges),
    annualPropertyTax: formatInputValue(values.annualPropertyTax),
    annualLandlordInsurance: formatInputValue(values.annualLandlordInsurance),
  };
}
