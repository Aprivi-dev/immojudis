"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { formatPrice } from "@/lib/format";
import { positiveListingNumber } from "@/lib/sale-listing";
import type { AuctionSale } from "@/lib/types";
import {
  getAiReviewFieldResult,
  type AiReviewProjectionReadModel,
  type AiReviewRequestStatus,
} from "@/lib/ai-review-guard";
import styles from "./FinancingSimulator.module.css";

const TERM_OPTIONS = [10, 15, 20, 25, 30] as const;
const DEFAULT_DOWN_PAYMENT_RATE = 0.2;
const DEFAULT_ANNUAL_RATE = 3.5;
const DEFAULT_TERM_YEARS = 20;
const DEFAULT_INSURANCE_RATE = 0.3;
const MAX_ANNUAL_RATE = 15;
const MAX_INSURANCE_RATE = 5;

export type FinancingInputs = {
  projectPrice: number;
  downPayment: number;
  annualRate: number;
  termYears: number;
  annualInsuranceRate?: number | null;
  /** Fees explicitly entered by the user and included in the financed project cost. */
  bankFees?: number;
  guaranteeFees?: number;
};

export type FinancingResult = {
  projectPrice: number;
  bankFees: number;
  guaranteeFees: number;
  totalProjectCost: number;
  downPayment: number;
  loanAmount: number;
  monthlyPrincipalAndInterest: number;
  monthlyInsurance: number;
  monthlyPayment: number;
  totalInterest: number;
  totalInsurance: number;
  totalRepaid: number;
  paymentCount: number;
};

export type FinancingDraft = {
  projectPrice: number | null;
  /** Whether the saved project price came from the shared scenario or a free user edit. */
  projectPriceSource?: "scenario" | "manual";
  downPayment: number | null;
  annualRate: number | null;
  termYears: number;
  insuranceEnabled: boolean;
  insuranceRate: number | null;
  bankFees: number | null;
  guaranteeFees: number | null;
};

/**
 * Calculates a standard amortizing loan. The insurance estimate deliberately
 * uses the initial loan amount for every month, so the result is easy to read
 * and is clearly presented as an illustration in the UI.
 */
export function calculateFinancing(inputs: FinancingInputs): FinancingResult | null {
  const {
    projectPrice,
    downPayment,
    annualRate,
    termYears,
    annualInsuranceRate = 0,
    bankFees = 0,
    guaranteeFees = 0,
  } = inputs;
  const insuranceRate = annualInsuranceRate ?? 0;

  if (
    ![
      projectPrice,
      downPayment,
      annualRate,
      termYears,
      insuranceRate,
      bankFees,
      guaranteeFees,
    ].every(Number.isFinite) ||
    projectPrice <= 0 ||
    downPayment < 0 ||
    bankFees < 0 ||
    guaranteeFees < 0 ||
    annualRate < 0 ||
    termYears <= 0 ||
    insuranceRate < 0
  ) {
    return null;
  }

  const totalProjectCost = projectPrice + bankFees + guaranteeFees;
  if (!Number.isFinite(totalProjectCost) || downPayment > totalProjectCost) return null;

  const loanAmount = totalProjectCost - downPayment;
  const paymentCount = Math.round(termYears * 12);
  if (paymentCount <= 0) return null;

  const monthlyRate = annualRate / 100 / 12;
  const monthlyPrincipalAndInterest =
    loanAmount === 0
      ? 0
      : monthlyRate === 0
        ? loanAmount / paymentCount
        : (loanAmount * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -paymentCount));
  const monthlyInsurance = (loanAmount * (insuranceRate / 100)) / 12;
  const totalInterest = Math.max(0, monthlyPrincipalAndInterest * paymentCount - loanAmount);
  const totalInsurance = monthlyInsurance * paymentCount;

  return {
    projectPrice,
    bankFees,
    guaranteeFees,
    totalProjectCost,
    downPayment,
    loanAmount,
    monthlyPrincipalAndInterest,
    monthlyInsurance,
    monthlyPayment: monthlyPrincipalAndInterest + monthlyInsurance,
    totalInterest,
    totalInsurance,
    totalRepaid: loanAmount + totalInterest + totalInsurance,
    paymentCount,
  };
}

export type FinancingSimulatorProps = {
  /** A full AuctionSale or a small object containing its published starting price. */
  sale: Pick<AuctionSale, "starting_price_eur">;
  /**
   * Optional scenario cost supplied by the detail workspace (acquisition + fees + works).
   * A positive value links and locks the cost; `undefined` falls back to the published starting
   * price, while `null` leaves a free amount for the user to enter.
   */
  projectPriceOverride?: number | null;
  /** Optional starting values for an embedded scenario; persistence stays with the parent. */
  initialDownPayment?: number | null;
  initialAnnualRate?: number;
  initialTermYears?: number;
  /** Providing this value also enables the optional insurance row initially. */
  initialInsuranceRate?: number | null;
  /** Optional starting values for costs that are explicitly included in the financed cost. */
  initialBankFees?: number | null;
  initialGuaranteeFees?: number | null;
  /** Optional numeric snapshot restored once when the simulator mounts; a linked cost wins for price. */
  initialDraft?: Partial<FinancingDraft> | null;
  /** Receives the current numeric inputs so a parent can restore them after unmounting. */
  onDraftChange?: (draft: FinancingDraft) => void;
  /** Receives the current estimate, or null while an input is invalid. */
  onResultChange?: (result: FinancingResult | null) => void;
  /** Useful when a page renders more than one simulator. */
  idPrefix?: string;
  /** Review rows for the published starting price. */
  aiReviewProjections?: readonly AiReviewProjectionReadModel[] | null;
  aiReviewStatus?: AiReviewRequestStatus;
};

function inputValue(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  return String(Number(value.toFixed(2)));
}

function parseInput(value: string): number | null {
  const normalized = value
    .trim()
    .replace(/[\s\u00a0\u202f]/g, "")
    .replace(",", ".");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeTerm(value: number | undefined): number {
  if (value != null && TERM_OPTIONS.includes(value as (typeof TERM_OPTIONS)[number])) {
    return value;
  }
  return DEFAULT_TERM_YEARS;
}

function normalizeFee(value: number | null | undefined): number {
  return value != null && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function FinancingSimulator({
  sale,
  projectPriceOverride,
  initialDownPayment,
  initialAnnualRate = DEFAULT_ANNUAL_RATE,
  initialTermYears = DEFAULT_TERM_YEARS,
  initialInsuranceRate,
  initialBankFees,
  initialGuaranteeFees,
  initialDraft = null,
  onDraftChange,
  onResultChange,
  idPrefix = "financing-simulator",
  aiReviewProjections = null,
  aiReviewStatus = "ready",
}: FinancingSimulatorProps) {
  const reactId = useId();
  const componentId = `${idPrefix}-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const priceReview = getAiReviewFieldResult(
    aiReviewProjections,
    "sale.starting_price_eur",
    aiReviewStatus,
  );
  const listingPrice = priceReview.blocked ? null : positiveListingNumber(sale.starting_price_eur);
  const linkedProjectPrice =
    projectPriceOverride === undefined ? null : positiveListingNumber(projectPriceOverride);
  const projectPriceIsLinked = linkedProjectPrice != null;
  const normalizedInitialPrice =
    projectPriceOverride === undefined ? listingPrice : linkedProjectPrice;
  const requestedInitialDownPayment =
    initialDownPayment != null && Number.isFinite(initialDownPayment)
      ? initialDownPayment
      : normalizedInitialPrice == null
        ? 0
        : Math.round(normalizedInitialPrice * DEFAULT_DOWN_PAYMENT_RATE);
  const normalizedInitialDownPayment = clamp(
    requestedInitialDownPayment,
    0,
    normalizedInitialPrice ?? Number.MAX_SAFE_INTEGER,
  );
  const normalizedInitialRate = clamp(
    Number.isFinite(initialAnnualRate) ? initialAnnualRate : DEFAULT_ANNUAL_RATE,
    0,
    MAX_ANNUAL_RATE,
  );
  const normalizedInitialTerm = normalizeTerm(initialTermYears);
  const normalizedInitialInsurance =
    initialInsuranceRate != null && Number.isFinite(initialInsuranceRate)
      ? clamp(initialInsuranceRate, 0, MAX_INSURANCE_RATE)
      : null;
  const normalizedInitialBankFees = normalizeFee(initialBankFees);
  const normalizedInitialGuaranteeFees = normalizeFee(initialGuaranteeFees);
  const staleScenarioPrice =
    projectPriceOverride === null && initialDraft?.projectPriceSource === "scenario";
  const initialProjectPrice = projectPriceIsLinked
    ? normalizedInitialPrice
    : staleScenarioPrice
      ? null
      : initialDraft?.projectPrice !== undefined
        ? initialDraft.projectPrice
        : normalizedInitialPrice;
  const initialDraftDownPayment =
    initialDraft?.downPayment !== undefined
      ? initialDraft.downPayment
      : normalizedInitialDownPayment;
  const initialDraftAnnualRate =
    initialDraft?.annualRate !== undefined ? initialDraft.annualRate : normalizedInitialRate;
  const initialDraftTerm = normalizeTerm(initialDraft?.termYears ?? normalizedInitialTerm);
  const initialDraftBankFees =
    initialDraft?.bankFees !== undefined ? initialDraft.bankFees : normalizedInitialBankFees;
  const initialDraftGuaranteeFees =
    initialDraft?.guaranteeFees !== undefined
      ? initialDraft.guaranteeFees
      : normalizedInitialGuaranteeFees;
  const initialDraftInsuranceRate =
    initialDraft?.insuranceRate !== undefined
      ? initialDraft.insuranceRate
      : (normalizedInitialInsurance ?? DEFAULT_INSURANCE_RATE);

  const [projectPriceInput, setProjectPriceInput] = useState(() => inputValue(initialProjectPrice));
  const [downPaymentInput, setDownPaymentInput] = useState(() =>
    inputValue(initialDraftDownPayment),
  );
  const [annualRateInput, setAnnualRateInput] = useState(() => inputValue(initialDraftAnnualRate));
  const [termYears, setTermYears] = useState(initialDraftTerm);
  const [bankFeesInput, setBankFeesInput] = useState(() => inputValue(initialDraftBankFees));
  const [guaranteeFeesInput, setGuaranteeFeesInput] = useState(() =>
    inputValue(initialDraftGuaranteeFees),
  );
  const [insuranceEnabled, setInsuranceEnabled] = useState(
    initialDraft?.insuranceEnabled ?? normalizedInitialInsurance != null,
  );
  const [insuranceRateInput, setInsuranceRateInput] = useState(() =>
    inputValue(initialDraftInsuranceRate),
  );
  const onDraftChangeRef = useRef(onDraftChange);
  const onResultChangeRef = useRef(onResultChange);

  useEffect(() => {
    onDraftChangeRef.current = onDraftChange;
  }, [onDraftChange]);

  useEffect(() => {
    onResultChangeRef.current = onResultChange;
  }, [onResultChange]);

  const previousInitialValues = useRef({
    price: normalizedInitialPrice,
    downPayment: normalizedInitialDownPayment,
    annualRate: normalizedInitialRate,
    term: normalizedInitialTerm,
    insurance: normalizedInitialInsurance,
    bankFees: normalizedInitialBankFees,
    guaranteeFees: normalizedInitialGuaranteeFees,
  });

  useEffect(() => {
    const previous = previousInitialValues.current;
    const priceChanged = previous.price !== normalizedInitialPrice;
    const changed =
      priceChanged ||
      previous.downPayment !== normalizedInitialDownPayment ||
      previous.annualRate !== normalizedInitialRate ||
      previous.term !== normalizedInitialTerm ||
      previous.insurance !== normalizedInitialInsurance ||
      previous.bankFees !== normalizedInitialBankFees ||
      previous.guaranteeFees !== normalizedInitialGuaranteeFees;
    previousInitialValues.current = {
      price: normalizedInitialPrice,
      downPayment: normalizedInitialDownPayment,
      annualRate: normalizedInitialRate,
      term: normalizedInitialTerm,
      insurance: normalizedInitialInsurance,
      bankFees: normalizedInitialBankFees,
      guaranteeFees: normalizedInitialGuaranteeFees,
    };
    if (!changed) return;

    if (priceChanged) {
      setProjectPriceInput(inputValue(normalizedInitialPrice));
      return;
    }

    setDownPaymentInput(inputValue(normalizedInitialDownPayment));
    setAnnualRateInput(inputValue(normalizedInitialRate));
    setTermYears(normalizedInitialTerm);
    setBankFeesInput(inputValue(normalizedInitialBankFees));
    setGuaranteeFeesInput(inputValue(normalizedInitialGuaranteeFees));
    setInsuranceEnabled(normalizedInitialInsurance != null);
    setInsuranceRateInput(inputValue(normalizedInitialInsurance ?? DEFAULT_INSURANCE_RATE));
  }, [
    normalizedInitialBankFees,
    normalizedInitialDownPayment,
    normalizedInitialGuaranteeFees,
    normalizedInitialInsurance,
    normalizedInitialPrice,
    normalizedInitialRate,
    normalizedInitialTerm,
  ]);

  const projectPrice = parseInput(projectPriceInput);
  const downPayment = parseInput(downPaymentInput);
  const annualRate = parseInput(annualRateInput);
  const bankFees = parseInput(bankFeesInput);
  const guaranteeFees = parseInput(guaranteeFeesInput);
  const insuranceRate = parseInput(insuranceRateInput);

  const totalProjectCost =
    projectPrice != null && bankFees != null && guaranteeFees != null
      ? projectPrice + bankFees + guaranteeFees
      : null;

  const errors = {
    projectPrice: projectPrice == null || projectPrice <= 0,
    bankFees: bankFees == null || bankFees < 0,
    guaranteeFees: guaranteeFees == null || guaranteeFees < 0,
    totalProjectCost: totalProjectCost != null && !Number.isFinite(totalProjectCost),
    downPayment:
      downPayment == null ||
      downPayment < 0 ||
      (totalProjectCost != null && downPayment > totalProjectCost),
    annualRate: annualRate == null || annualRate < 0 || annualRate > MAX_ANNUAL_RATE,
    insurance:
      insuranceEnabled &&
      (insuranceRate == null || insuranceRate < 0 || insuranceRate > MAX_INSURANCE_RATE),
  };
  const hasErrors = Object.values(errors).some(Boolean);
  const result = useMemo(
    () =>
      hasErrors ||
      projectPrice == null ||
      downPayment == null ||
      annualRate == null ||
      bankFees == null ||
      guaranteeFees == null
        ? null
        : calculateFinancing({
            projectPrice,
            downPayment,
            annualRate,
            termYears,
            bankFees,
            guaranteeFees,
            annualInsuranceRate: insuranceEnabled ? insuranceRate : 0,
          }),
    [
      annualRate,
      bankFees,
      downPayment,
      guaranteeFees,
      hasErrors,
      insuranceEnabled,
      insuranceRate,
      projectPrice,
      termYears,
    ],
  );

  const downPaymentPercent =
    totalProjectCost != null && totalProjectCost > 0 && downPayment != null
      ? clamp((downPayment / totalProjectCost) * 100, 0, 100)
      : 0;
  const projectPriceSource = projectPriceIsLinked ? ("scenario" as const) : ("manual" as const);

  useEffect(() => {
    onDraftChangeRef.current?.({
      projectPrice,
      projectPriceSource,
      downPayment,
      annualRate,
      termYears,
      insuranceEnabled,
      insuranceRate,
      bankFees,
      guaranteeFees,
    });
  }, [
    annualRate,
    bankFees,
    downPayment,
    guaranteeFees,
    insuranceEnabled,
    insuranceRate,
    projectPrice,
    projectPriceSource,
    termYears,
  ]);

  useEffect(() => {
    onResultChangeRef.current?.(result);
  }, [result]);

  const ids = {
    projectPrice: `${componentId}-project-price`,
    downPayment: `${componentId}-down-payment`,
    downPaymentRange: `${componentId}-down-payment-range`,
    annualRate: `${componentId}-annual-rate`,
    termYears: `${componentId}-term-years`,
    bankFees: `${componentId}-bank-fees`,
    guaranteeFees: `${componentId}-guarantee-fees`,
    insuranceEnabled: `${componentId}-insurance-enabled`,
    insuranceRate: `${componentId}-insurance-rate`,
    projectPriceHelp: `${componentId}-project-price-help`,
    downPaymentHelp: `${componentId}-down-payment-help`,
    annualRateHelp: `${componentId}-annual-rate-help`,
    bankFeesHelp: `${componentId}-bank-fees-help`,
    guaranteeFeesHelp: `${componentId}-guarantee-fees-help`,
    insuranceHelp: `${componentId}-insurance-help`,
  };

  return (
    <section className={styles.section} aria-labelledby={`${componentId}-title`}>
      <div className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Financement</p>
          <h2 id={`${componentId}-title`} className={styles.title}>
            Simulateur de financement
          </h2>
          <p className={styles.subtitle}>
            Ajustez le prix, l’apport et les frais pour obtenir une première mensualité.
          </p>
        </div>
        <div className={styles.illustrativeBadge}>Hypothèses illustratives</div>
      </div>

      <div className={styles.layout}>
        <form className={styles.inputPanel} onSubmit={(event) => event.preventDefault()} noValidate>
          <fieldset className={styles.fieldset}>
            <legend className={styles.panelTitle}>Vos paramètres</legend>
            <p className={styles.panelIntro}>Modifiez les valeurs pour ajuster votre scénario.</p>

            <div className={styles.fieldGroup}>
              <label className={styles.label} htmlFor={ids.projectPrice}>
                Prix du projet <span className={styles.unit}>(€)</span>
              </label>
              <input
                id={ids.projectPrice}
                className={styles.input}
                type="number"
                min="1"
                max="1000000000"
                step="1000"
                inputMode="decimal"
                value={projectPriceInput}
                disabled={projectPriceIsLinked}
                onChange={(event) => setProjectPriceInput(event.currentTarget.value)}
                aria-invalid={errors.projectPrice || undefined}
                aria-describedby={ids.projectPriceHelp}
              />
              <p id={ids.projectPriceHelp} className={styles.help}>
                {projectPriceIsLinked ? (
                  <>
                    <strong className={styles.modeBadge}>Scénario de l’annonce</strong> · coût
                    partagé avec l’analyse : {formatPrice(normalizedInitialPrice)}.
                  </>
                ) : (
                  <>
                    <strong className={styles.modeBadge}>Montant libre</strong> ·{" "}
                    {normalizedInitialPrice == null
                      ? "renseignez un montant pour activer la simulation."
                      : projectPriceOverride === undefined
                        ? `mise à prix de l’annonce : ${formatPrice(listingPrice ?? normalizedInitialPrice)}.`
                        : "le coût du scénario n’est pas disponible, vous pouvez saisir un montant."}
                  </>
                )}
              </p>
              {errors.projectPrice ? (
                <p className={styles.error} role="alert">
                  Saisissez un prix supérieur à 0 €.
                </p>
              ) : null}
            </div>

            <div className={styles.twoColumns}>
              <div className={styles.fieldGroup}>
                <label className={styles.label} htmlFor={ids.bankFees}>
                  Frais de dossier bancaires <span className={styles.unit}>(€)</span>
                </label>
                <input
                  id={ids.bankFees}
                  className={styles.input}
                  type="number"
                  min="0"
                  max="1000000000"
                  step="100"
                  inputMode="decimal"
                  value={bankFeesInput}
                  onChange={(event) => setBankFeesInput(event.currentTarget.value)}
                  aria-invalid={errors.bankFees || undefined}
                  aria-describedby={ids.bankFeesHelp}
                />
                <p id={ids.bankFeesHelp} className={styles.help}>
                  0 € si le montant n’est pas communiqué.
                </p>
                {errors.bankFees ? (
                  <p className={styles.error} role="alert">
                    Saisissez des frais bancaires supérieurs ou égaux à 0 €.
                  </p>
                ) : null}
              </div>

              <div className={styles.fieldGroup}>
                <label className={styles.label} htmlFor={ids.guaranteeFees}>
                  Garantie / caution <span className={styles.unit}>(€)</span>
                </label>
                <input
                  id={ids.guaranteeFees}
                  className={styles.input}
                  type="number"
                  min="0"
                  max="1000000000"
                  step="100"
                  inputMode="decimal"
                  value={guaranteeFeesInput}
                  onChange={(event) => setGuaranteeFeesInput(event.currentTarget.value)}
                  aria-invalid={errors.guaranteeFees || undefined}
                  aria-describedby={ids.guaranteeFeesHelp}
                />
                <p id={ids.guaranteeFeesHelp} className={styles.help}>
                  Saisie séparément puis ajoutée au coût total.
                </p>
                {errors.guaranteeFees ? (
                  <p className={styles.error} role="alert">
                    Saisissez une garantie supérieure ou égale à 0 €.
                  </p>
                ) : null}
              </div>
            </div>

            <div className={styles.fieldGroup}>
              <label className={styles.label} htmlFor={ids.downPayment}>
                Apport personnel <span className={styles.unit}>(€)</span>
              </label>
              <input
                id={ids.downPayment}
                className={styles.input}
                type="number"
                min="0"
                max={totalProjectCost ?? undefined}
                step="1000"
                inputMode="decimal"
                value={downPaymentInput}
                onChange={(event) => setDownPaymentInput(event.currentTarget.value)}
                aria-invalid={errors.downPayment || undefined}
                aria-describedby={ids.downPaymentHelp}
              />
              <input
                id={ids.downPaymentRange}
                className={styles.range}
                type="range"
                min="0"
                max="100"
                step="1"
                value={downPaymentPercent}
                disabled={totalProjectCost == null || totalProjectCost <= 0}
                onChange={(event) => {
                  if (totalProjectCost == null || totalProjectCost <= 0) return;
                  const percentage = Number(event.currentTarget.value);
                  setDownPaymentInput(inputValue((totalProjectCost * percentage) / 100));
                }}
                aria-label="Pourcentage d’apport"
                aria-valuetext={`${Math.round(downPaymentPercent)} % du coût total du projet`}
              />
              <div className={styles.rangeMeta} aria-hidden="true">
                <span>0 %</span>
                <span>{Math.round(downPaymentPercent)} %</span>
                <span>100 %</span>
              </div>
              <p id={ids.downPaymentHelp} className={styles.help}>
                Ajustez l’apport avec le curseur.
              </p>
              {errors.downPayment ? (
                <p className={styles.error} role="alert">
                  L’apport doit être compris entre 0 € et le coût total du projet.
                </p>
              ) : null}
            </div>

            <div className={styles.twoColumns}>
              <div className={styles.fieldGroup}>
                <label className={styles.label} htmlFor={ids.annualRate}>
                  Taux annuel <span className={styles.unit}>(%)</span>
                </label>
                <div className={styles.inputSuffix}>
                  <input
                    id={ids.annualRate}
                    className={styles.input}
                    type="number"
                    min="0"
                    max={MAX_ANNUAL_RATE}
                    step="0.01"
                    inputMode="decimal"
                    value={annualRateInput}
                    onChange={(event) => setAnnualRateInput(event.currentTarget.value)}
                    aria-invalid={errors.annualRate || undefined}
                    aria-describedby={ids.annualRateHelp}
                  />
                  <span aria-hidden="true">%</span>
                </div>
                <p id={ids.annualRateHelp} className={styles.help}>
                  Hypothèse de départ : 3,5 %.
                </p>
                {errors.annualRate ? (
                  <p className={styles.error} role="alert">
                    Choisissez un taux entre 0 % et 15 %.
                  </p>
                ) : null}
              </div>

              <div className={styles.fieldGroup}>
                <label className={styles.label} htmlFor={ids.termYears}>
                  Durée du prêt
                </label>
                <select
                  id={ids.termYears}
                  className={styles.input}
                  value={termYears}
                  onChange={(event) => setTermYears(Number(event.currentTarget.value))}
                >
                  {TERM_OPTIONS.map((term) => (
                    <option key={term} value={term}>
                      {term} ans
                    </option>
                  ))}
                </select>
                <p className={styles.help}>Choisissez une durée.</p>
              </div>
            </div>

            <div className={styles.insuranceBlock}>
              <label className={styles.checkboxLabel} htmlFor={ids.insuranceEnabled}>
                <input
                  id={ids.insuranceEnabled}
                  type="checkbox"
                  checked={insuranceEnabled}
                  onChange={(event) => setInsuranceEnabled(event.currentTarget.checked)}
                />
                <span>Ajouter une assurance indicative</span>
              </label>
              {insuranceEnabled ? (
                <div className={styles.insuranceField}>
                  <label className={styles.label} htmlFor={ids.insuranceRate}>
                    Taux d’assurance annuel <span className={styles.unit}>(%)</span>
                  </label>
                  <div className={styles.inputSuffix}>
                    <input
                      id={ids.insuranceRate}
                      className={styles.input}
                      type="number"
                      min="0"
                      max={MAX_INSURANCE_RATE}
                      step="0.01"
                      inputMode="decimal"
                      value={insuranceRateInput}
                      onChange={(event) => setInsuranceRateInput(event.currentTarget.value)}
                      aria-invalid={errors.insurance || undefined}
                      aria-describedby={ids.insuranceHelp}
                    />
                    <span aria-hidden="true">%</span>
                  </div>
                  <p id={ids.insuranceHelp} className={styles.help}>
                    Hypothèse constante sur le capital emprunté : 0,30 % / an.
                  </p>
                  {errors.insurance ? (
                    <p className={styles.error} role="alert">
                      Choisissez un taux d’assurance entre 0 % et 5 %.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>

            <p className={styles.privateNote}>Les valeurs restent dans votre navigateur.</p>
          </fieldset>
        </form>

        <aside className={styles.resultPanel} aria-labelledby={`${componentId}-results-title`}>
          <p className={styles.panelKicker}>Résultat estimé</p>
          <h3 id={`${componentId}-results-title`} className={styles.resultTitle}>
            Votre mensualité
          </h3>
          <p className={styles.panelIntro}>
            Prêt amortissable à mensualités constantes, mis à jour dès que vous modifiez un
            paramètre.
          </p>

          <div className={styles.resultStatus} role="status" aria-live="polite" aria-atomic="true">
            {result ? (
              <>
                <span className={styles.resultLabel}>Mensualité totale estimée</span>
                <strong>{formatPrice(Math.round(result.monthlyPayment))}</strong>
                <span className={styles.annualResult}>
                  {formatPrice(Math.round(result.monthlyPayment * 12))} / an
                </span>
              </>
            ) : (
              <>
                <span className={styles.resultLabel}>Mensualité totale estimée</span>
                <strong>À compléter</strong>
                <span className={styles.annualResult}>Renseignez des hypothèses valides</span>
              </>
            )}
          </div>

          {result ? (
            <p className={styles.resultSummary}>
              {formatPrice(Math.round(result.loanAmount))} empruntés sur {termYears} ans · coût
              total {formatPrice(Math.round(result.totalProjectCost))}
            </p>
          ) : (
            <p className={styles.emptyResult}>
              Le résultat s’affichera avec des hypothèses valides.
            </p>
          )}

          <div className={styles.detailContent}>
            <p className={styles.detailIntro}>
              Ces chiffres servent de repère et ne constituent pas une offre de prêt.
            </p>
            {result ? (
              <dl className={styles.resultRows}>
                <div>
                  <dt>Prix du projet</dt>
                  <dd>{formatPrice(Math.round(result.projectPrice))}</dd>
                </div>
                <div>
                  <dt>Frais de dossier bancaires</dt>
                  <dd>{formatPrice(Math.round(result.bankFees))}</dd>
                </div>
                <div>
                  <dt>Garantie / caution</dt>
                  <dd>{formatPrice(Math.round(result.guaranteeFees))}</dd>
                </div>
                <div className={styles.costTotalRow}>
                  <dt>Coût total du projet</dt>
                  <dd>{formatPrice(Math.round(result.totalProjectCost))}</dd>
                </div>
                <div>
                  <dt>Apport personnel</dt>
                  <dd>{formatPrice(Math.round(result.downPayment))}</dd>
                </div>
                <div className={styles.financedRow}>
                  <dt>Montant emprunté</dt>
                  <dd>{formatPrice(Math.round(result.loanAmount))}</dd>
                </div>
                <div>
                  <dt>Mensualité du crédit</dt>
                  <dd>{formatPrice(Math.round(result.monthlyPrincipalAndInterest))}</dd>
                </div>
                <div>
                  <dt>Intérêts estimés</dt>
                  <dd>{formatPrice(Math.round(result.totalInterest))}</dd>
                </div>
                {insuranceEnabled ? (
                  <>
                    <div>
                      <dt>Assurance par mois</dt>
                      <dd>{formatPrice(Math.round(result.monthlyInsurance))}</dd>
                    </div>
                    <div>
                      <dt>Assurance sur la durée</dt>
                      <dd>{formatPrice(Math.round(result.totalInsurance))}</dd>
                    </div>
                  </>
                ) : null}
                <div className={styles.totalRow}>
                  <dt>Total estimé remboursé</dt>
                  <dd>{formatPrice(Math.round(result.totalRepaid))}</dd>
                </div>
              </dl>
            ) : null}

            <p className={styles.resultNote}>
              Les frais bancaires et la garantie saisis sont ajoutés au coût total puis au montant
              emprunté selon cette hypothèse. Votre banque peut demander un paiement comptant ou un
              autre montant. L’assurance utilise une hypothèse constante sur le capital initial.
              Fiscalité et frais d’acquisition complémentaires ne sont pas calculés ici ; les
              travaux ne sont inclus que s’ils figurent déjà dans le coût du scénario.
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}
