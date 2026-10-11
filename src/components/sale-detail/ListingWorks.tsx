"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.js";
import {
  worksScenarioForAmount,
  WorksScenarioSelector,
} from "@/components/bid-ceiling/BidCeilingWorks";
import { buildDpeAnalysis } from "@/lib/dpe-analysis";
import { formatPrice } from "@/lib/format";
import { getListingPublicInformation } from "@/lib/listing-public-information";
import { estimateWorksBudget, WORKS_SCENARIOS } from "@/lib/profitability";
import { riskEvidence } from "@/lib/risk-evidence";
import { dpeRentalNote, suggestWorksScenario } from "@/lib/works-guidance";
import type { AuctionSale, SaleRisk } from "@/lib/types";
import styles from "./ListingWorks.module.css";

/** Published condition (« État du bien »): sourced fact first, then the raw source block. */
function saleCondition(sale: AuctionSale): string | null {
  const fact = getListingPublicInformation(sale).items.find((item) => item.id === "condition");
  if (fact?.value) return fact.value;
  const block = (sale.source_blocks as Record<string, unknown> | null | undefined)?.etat;
  return typeof block === "string" && block.trim() ? block.trim() : null;
}

function workRisks(sale: AuctionSale): SaleRisk[] {
  return (sale.risks ?? []).filter((risk) =>
    /work|travaux|rénov|renov/i.test(`${risk.risk_type} ${risk.risk_label}`),
  );
}

type BudgetLine = {
  id: string;
  label: string;
  quantity: string;
  unit: string;
  unitPrice: string;
};

export type ListingWorksDraftLine = Omit<BudgetLine, "id"> & { id?: string };

export type ListingWorksDraft = {
  lines: readonly ListingWorksDraftLine[];
};

export type ListingWorksBudgetSource = "estimate" | "quote";

export type ListingWorksProps = {
  sale: AuctionSale;
  estimatedBudget: number | null;
  /** The amount is shared only after the user explicitly applies a complete budget. */
  onBudgetChange?: (budget: number) => void;
  /** Optional draft restored by the parent when the user changes announcement tabs. */
  initialDraft?: ListingWorksDraft | null;
  /** Receives incomplete lines too, so the parent can preserve the working draft. */
  onDraftChange?: (draft: ListingWorksDraft) => void;
  /** Optional future source metadata; the default remains an analysis estimate. */
  budgetSource?: ListingWorksBudgetSource;
  /** Built surface used by the scenario budgets; the scenario picker needs it. */
  surface?: number | null;
  /** Retains a scenario budget or a quote amount (shown when a budget can be kept). */
  onScenarioSelect?: (budget: number) => void;
  /** Works envelope still compatible with the ceiling at the simulated bid. */
  maxWorks?: number | null;
};

function normalizeBudget(value: number | null): number | null {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseNonNegativeNumber(value: string): number | null {
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function lineTotal(line: BudgetLine): number | null {
  if (!line.label.trim()) return null;
  const quantity = parseNonNegativeNumber(line.quantity);
  const unitPrice = parseNonNegativeNumber(line.unitPrice);
  if (quantity == null || quantity <= 0 || unitPrice == null) return null;
  const total = quantity * unitPrice;
  return Number.isFinite(total) ? total : null;
}

function emptyLine(id: string): BudgetLine {
  return { id, label: "", quantity: "1", unit: "forfait", unitPrice: "" };
}

function draftLines(
  draft: ListingWorksDraft | null | undefined,
  componentId: string,
): BudgetLine[] {
  return (draft?.lines ?? []).map((line, index) => ({
    id: line.id || `${componentId}-line-${index}`,
    label: line.label ?? "",
    quantity: line.quantity ?? "",
    unit: line.unit ?? "",
    unitPrice: line.unitPrice ?? "",
  }));
}

function serializeLines(lines: readonly BudgetLine[]): string {
  return JSON.stringify(
    lines.map(({ label, quantity, unit, unitPrice }) => ({ label, quantity, unit, unitPrice })),
  );
}

function toDraft(lines: readonly BudgetLine[]): ListingWorksDraft {
  return {
    lines: lines.map(({ id, label, quantity, unit, unitPrice }) => ({
      id,
      label,
      quantity,
      unit,
      unitPrice,
    })),
  };
}

export function ListingWorks({
  sale,
  estimatedBudget,
  onBudgetChange,
  initialDraft,
  onDraftChange,
  budgetSource,
  surface = null,
  onScenarioSelect,
  maxWorks = null,
}: ListingWorksProps) {
  const componentId = `listing-works-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const initialLines = useMemo(
    () => draftLines(initialDraft, componentId),
    [componentId, initialDraft],
  );
  const lineId = useRef(initialLines.length);
  const linesRef = useRef(initialLines);
  const [lines, setLines] = useState<BudgetLine[]>(initialLines);
  const lastDraftSignature = useRef(serializeLines(initialLines));
  const [appliedBudget, setAppliedBudget] = useState<number | null>(null);
  const normalizedEstimatedBudget = normalizeBudget(estimatedBudget);
  const risks = workRisks(sale);
  const firstRisk = risks[0];
  const lineTotals = useMemo(() => lines.map(lineTotal), [lines]);
  const allLinesComplete = lines.length > 0 && lineTotals.every((value) => value != null);
  const detailedTotal = allLinesComplete
    ? lineTotals.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
  const displayedBudget = detailedTotal ?? normalizedEstimatedBudget;
  const resolvedSource = budgetSource ?? (normalizedEstimatedBudget != null ? "estimate" : null);
  const scenarioSurface = surface != null && surface > 0 ? surface : null;
  const selectedScenario = worksScenarioForAmount(scenarioSurface, normalizedEstimatedBudget ?? 0);
  const selectedScenarioConfig = WORKS_SCENARIOS.find((item) => item.key === selectedScenario);
  const showScenarioPicker = scenarioSurface != null && onScenarioSelect != null;
  const condition = useMemo(() => saleCondition(sale), [sale]);
  const dpeClass = useMemo(() => buildDpeAnalysis(sale).class, [sale]);
  const suggestion = suggestWorksScenario(condition, dpeClass);
  const dpeNote = dpeRentalNote(dpeClass);
  const budgetLabel =
    detailedTotal != null
      ? "Détail saisi"
      : resolvedSource === "quote"
        ? "Devis transmis"
        : normalizedEstimatedBudget == null
          ? "Données insuffisantes"
          : normalizedEstimatedBudget === 0
            ? "Aucun travaux"
            : selectedScenarioConfig
              ? selectedScenarioConfig.label
              : "Montant personnalisé";
  const budgetNote =
    detailedTotal != null
      ? "Total calculé depuis vos postes. Il reste à confronter à un devis."
      : resolvedSource === "quote"
        ? "Montant issu d’un devis transmis dans le dossier. Vérifiez les postes et la date."
        : normalizedEstimatedBudget == null
          ? "Aucune enveloppe disponible dans cette fiche. Ajoutez des postes vérifiés pour créer votre hypothèse."
          : normalizedEstimatedBudget === 0
            ? showScenarioPicker
              ? "Aucun budget retenu : choisissez un scénario ci-dessus, saisissez un devis ou détaillez vos postes."
              : "Aucun budget retenu dans cette simulation."
            : selectedScenarioConfig && scenarioSurface
              ? `Estimation : ${new Intl.NumberFormat("fr-FR").format(scenarioSurface)} m² × ${formatPrice(selectedScenarioConfig.pricePerM2)}/m², à confirmer par des devis.`
              : "Enveloppe de simulation à confirmer par des devis.";
  const exceedsEnvelope =
    maxWorks != null && displayedBudget != null && displayedBudget > Math.max(0, maxWorks);

  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);

  useEffect(() => {
    const restoredLines = draftLines(initialDraft, componentId);
    const restoredSignature = serializeLines(restoredLines);
    if (restoredSignature === serializeLines(linesRef.current)) return;
    linesRef.current = restoredLines;
    lastDraftSignature.current = restoredSignature;
    lineId.current = Math.max(lineId.current, restoredLines.length);
    setLines(restoredLines);
  }, [componentId, initialDraft]);

  useEffect(() => {
    const currentSignature = serializeLines(lines);
    if (currentSignature === lastDraftSignature.current) return;
    lastDraftSignature.current = currentSignature;
    onDraftChange?.(toDraft(lines));
  }, [lines, onDraftChange]);

  const addLine = () => {
    const id = `${componentId}-line-${lineId.current}`;
    lineId.current += 1;
    setLines((current) => [...current, emptyLine(id)]);
  };

  const updateLine = (
    id: string,
    field: "label" | "quantity" | "unit" | "unitPrice",
    value: string,
  ) => {
    setLines((current) =>
      current.map((line) => (line.id === id ? { ...line, [field]: value } : line)),
    );
  };

  const removeLine = (id: string) => {
    setLines((current) => current.filter((line) => line.id !== id));
  };

  const applyBudget = () => {
    if (displayedBudget == null || onBudgetChange == null) return;
    onBudgetChange(displayedBudget);
    setAppliedBudget(displayedBudget);
  };

  const selectScenario = (scenario: (typeof WORKS_SCENARIOS)[number]["key"] | null) => {
    if (!onScenarioSelect || scenarioSurface == null) return;
    onScenarioSelect(scenario ? estimateWorksBudget(scenarioSurface, scenario) : 0);
  };

  const changeLine =
    (id: string, field: "label" | "quantity" | "unit" | "unitPrice") =>
    (event: ChangeEvent<HTMLInputElement>) => {
      updateLine(id, field, event.target.value);
    };

  return (
    <section id="works" aria-labelledby="listing-works-title" className={styles.section}>
      <div className={styles.inner}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>04 / Travaux</p>
            <h2 id="listing-works-title" className={styles.title}>
              Travaux et état du bien
            </h2>
            <p className={styles.subtitle}>
              Chiffrez votre projet et faites confirmer les postes lors de la visite.
            </p>
          </div>
          <span className={styles.headerBadge}>Hypothèse à confirmer</span>
        </header>

        {showScenarioPicker ? (
          <div className={styles.picker}>
            <WorksScenarioSelector
              surface={scenarioSurface}
              works={normalizedEstimatedBudget ?? 0}
              selectedScenario={selectedScenario}
              suggestedScenario={suggestion ? suggestion.scenario : undefined}
              suggestionReason={suggestion?.reason}
              onSelect={selectScenario}
            />
          </div>
        ) : null}

        <div className={styles.results}>
          <article className={`${styles.resultCard} ${styles.primaryResult}`}>
            <div className={styles.resultTopline}>
              <p className={styles.resultLabel}>Budget travaux retenu</p>
              <span className={styles.sourceBadge}>{budgetLabel}</span>
            </div>
            <p className={styles.resultValue} aria-live="polite">
              {displayedBudget != null ? formatPrice(displayedBudget) : "Non estimé"}
            </p>
            <p className={styles.resultNote}>{budgetNote}</p>
            {exceedsEnvelope ? (
              <p className={styles.envelopeWarning}>
                Ce budget dépasse l’enveloppe travaux maximale (
                {formatPrice(Math.max(0, Math.floor((maxWorks ?? 0) / 100) * 100))}) : même à la
                mise simulée, le coût complet dépasserait le seuil de marché. L’enchère plafond
                baisse d’autant.
              </p>
            ) : null}
            <div className={styles.primaryActions}>
              {onBudgetChange && detailedTotal != null ? (
                <button type="button" className={styles.applyButton} onClick={applyBudget}>
                  {appliedBudget === displayedBudget ? "Budget utilisé" : "Utiliser ce budget"}
                </button>
              ) : null}
              {showScenarioPicker && detailedTotal == null ? (
                <label className={styles.quoteField}>
                  <span>Montant d’un devis</span>
                  <span className={styles.quoteInput}>
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step={500}
                      value={normalizedEstimatedBudget ?? 0}
                      onChange={(event) =>
                        onScenarioSelect?.(Math.max(0, parseFloat(event.target.value) || 0))
                      }
                      aria-label="Montant d’un devis travaux"
                    />
                    <span aria-hidden>€</span>
                  </span>
                </label>
              ) : null}
              {lines.length === 0 ? (
                <button type="button" className={styles.addButton} onClick={addLine}>
                  <Plus className={styles.buttonIcon} aria-hidden />
                  Détailler le budget
                </button>
              ) : null}
            </div>
          </article>

          <article className={styles.resultCard}>
            <div className={styles.resultTopline}>
              <p className={styles.resultLabel}>État et énergie</p>
              <span className={styles.evidenceCount}>
                {risks.length === 0
                  ? "Aucun constat"
                  : `${risks.length} constat${risks.length > 1 ? "s" : ""}`}
              </span>
            </div>
            <dl className={styles.facts}>
              <div>
                <dt>État du bien</dt>
                <dd>{condition ?? "Non décrit dans le dossier"}</dd>
              </div>
              <div>
                <dt>Diagnostic énergétique</dt>
                <dd>{dpeClass ? `DPE ${dpeClass}` : "Classe DPE non identifiée"}</dd>
              </div>
            </dl>
            {dpeNote ? (
              <p className={styles.dpeNote} data-tone={dpeNote.tone}>
                {dpeNote.text}
              </p>
            ) : null}
            <p className={styles.resultSecondaryNote}>
              {firstRisk
                ? `${firstRisk.risk_label}${risks.length > 1 ? ` et ${risks.length - 1} autre${risks.length > 2 ? "s" : ""} point${risks.length > 2 ? "s" : ""}` : ""} : voir les constats ci-dessous.`
                : "Aucun constat de travaux documenté dans les pièces."}
            </p>
          </article>
        </div>

        {lines.length > 0 ? (
          <section className={styles.editor} aria-labelledby={`${componentId}-editor-title`}>
            <div className={styles.editorHeader}>
              <div>
                <p className={styles.eyebrow}>Détail facultatif</p>
                <h3 id={`${componentId}-editor-title`} className={styles.editorTitle}>
                  Décomposer l’enveloppe
                </h3>
                <p className={styles.editorIntro}>
                  Saisissez quantité, unité et prix unitaire lorsque le dossier permet de les
                  vérifier.
                </p>
              </div>
              <span className={styles.editorMeta}>
                {allLinesComplete ? "Détail complet" : "Détail à compléter"}
              </span>
            </div>
            <div className={styles.lineList} role="list" aria-label="Postes du budget travaux">
              <div className={styles.lineHeader} aria-hidden="true">
                <span>Poste</span>
                <span>Quantité</span>
                <span>Unité</span>
                <span>Prix unitaire</span>
                <span>Total</span>
                <span className="sr-only">Action</span>
              </div>
              {lines.map((line, index) => {
                const total = lineTotals[index];
                return (
                  <div key={line.id} className={styles.line} role="listitem">
                    <label className={`${styles.field} ${styles.labelField}`}>
                      <span className={styles.mobileFieldLabel}>Poste {index + 1}</span>
                      <input
                        className={styles.input}
                        value={line.label}
                        onChange={changeLine(line.id, "label")}
                        placeholder="Ex. Peinture"
                        aria-label={`Libellé du poste ${index + 1}`}
                      />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.mobileFieldLabel}>Quantité</span>
                      <input
                        className={styles.input}
                        type="number"
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        value={line.quantity}
                        onChange={changeLine(line.id, "quantity")}
                        aria-label={`Quantité du poste ${index + 1}`}
                      />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.mobileFieldLabel}>Unité</span>
                      <input
                        className={styles.input}
                        value={line.unit}
                        onChange={changeLine(line.id, "unit")}
                        placeholder="m²"
                        aria-label={`Unité du poste ${index + 1}`}
                      />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.mobileFieldLabel}>Prix unitaire (€)</span>
                      <input
                        className={styles.input}
                        type="number"
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        value={line.unitPrice}
                        onChange={changeLine(line.id, "unitPrice")}
                        placeholder="0"
                        aria-label={`Prix unitaire du poste ${index + 1}`}
                      />
                    </label>
                    <output className={styles.lineTotal} aria-label={`Total du poste ${index + 1}`}>
                      {total != null ? formatPrice(total) : "À compléter"}
                    </output>
                    <button
                      className={styles.removeButton}
                      type="button"
                      onClick={() => removeLine(line.id)}
                      aria-label={`Supprimer le poste ${index + 1}`}
                    >
                      <Trash2 className={styles.buttonIcon} aria-hidden />
                    </button>
                  </div>
                );
              })}
              <div className={styles.totalRow}>
                <div>
                  <p className={styles.totalLabel}>Total des postes détaillés</p>
                  {!allLinesComplete ? (
                    <p className={styles.totalNote}>
                      Complétez chaque ligne pour remplacer l’estimation de référence.
                    </p>
                  ) : null}
                </div>
                <strong className={styles.totalValue}>
                  {detailedTotal != null ? formatPrice(detailedTotal) : "—"}
                </strong>
              </div>
            </div>
            <button type="button" className={styles.secondaryButton} onClick={addLine}>
              <Plus className={styles.buttonIcon} aria-hidden />
              Ajouter un poste
            </button>
          </section>
        ) : null}

        {risks.length > 0 ? (
          <details className={styles.evidenceDisclosure}>
            <summary>
              <span>Voir les constats et les sources</span>
              <span className={styles.evidenceSummaryCount}>
                {risks.length} point{risks.length > 1 ? "s" : ""}
              </span>
              <ChevronDown className={styles.chevron} aria-hidden />
            </summary>

            <div className={styles.evidenceBody}>
              {risks.length > 0 ? (
                <ul className={styles.evidenceList} aria-label="Points travaux du dossier">
                  {risks.map((risk, index) => {
                    const evidence = riskEvidence(risk);
                    const proof = evidence.proofs[0];
                    return (
                      <li key={`${risk.risk_type}-${risk.risk_label}-${index}`}>
                        <p className={styles.evidenceTitle}>{risk.risk_label}</p>
                        <div className={styles.evidenceText}>
                          {proof.excerpt ? <p>{proof.excerpt}</p> : null}
                          <p>
                            {proof.url ? (
                              <a href={proof.url} target="_blank" rel="noopener noreferrer">
                                {proof.label} (nouvel onglet)
                              </a>
                            ) : (
                              proof.label
                            )}
                            {proof.page != null ? ` · page ${proof.page}` : ""}
                          </p>
                          <p>{evidence.action}</p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className={styles.emptyEvidence}>
                  Aucun constat de travaux documenté n’est disponible dans cette fiche. Faites
                  vérifier l’état du bien et les pièces avant de retenir un budget.
                </p>
              )}

              {normalizedEstimatedBudget != null ? (
                <p className={styles.evidenceNote}>
                  Cette enveloppe est une hypothèse ajustable dans le calcul d’enchère plafond ;
                  elle ne remplace pas un devis établi après visite.
                </p>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>
    </section>
  );
}
