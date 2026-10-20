"use client";

import { useMemo } from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import {
  worksScenarioForAmount,
  WorksScenarioSelector,
} from "@/components/bid-ceiling/BidCeilingWorks";
import { WorksBreakdownPanel } from "@/components/sale-detail/WorksBreakdownPanel";
import { buildDpeAnalysis } from "@/lib/dpe-analysis";
import { formatPrice } from "@/lib/format";
import { estimateWorksBudget, WORKS_SCENARIOS } from "@/lib/profitability";
import { riskEvidence } from "@/lib/risk-evidence";
import { summarizeWorksBreakdown, type WorksBreakdownItem } from "@/lib/works-breakdown";
import { dpeRentalNote, saleCondition, suggestWorksScenario } from "@/lib/works-guidance";
import type { AuctionSale, SaleRisk } from "@/lib/types";
import styles from "./ListingWorks.module.css";

function workRisks(sale: AuctionSale): SaleRisk[] {
  return (sale.risks ?? []).filter((risk) =>
    /work|travaux|rénov|renov/i.test(`${risk.risk_type} ${risk.risk_label}`),
  );
}

export type ListingWorksProps = {
  sale: AuctionSale;
  estimatedBudget: number | null;
  /** Built surface used by the scenario budgets; the scenario picker needs it. */
  surface?: number | null;
  /** Retains the budget of a scenario (or 0 for « Aucun travaux »). */
  onScenarioSelect?: (budget: number) => void;
  /** Works envelope still compatible with the ceiling at the simulated bid. */
  maxWorks?: number | null;
  /** Postes saisis dans « Détail de vos travaux » (conservés avec les hypothèses du calcul). */
  worksBreakdown?: readonly WorksBreakdownItem[];
  /** Reçoit les postes et leur total ; sans lui, le panneau « Détailler les travaux » est absent. */
  onWorksBreakdownChange?: (items: WorksBreakdownItem[], total: number) => void;
};

function normalizeBudget(value: number | null): number | null {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null;
}

export function ListingWorks({
  sale,
  estimatedBudget,
  surface = null,
  onScenarioSelect,
  maxWorks = null,
  worksBreakdown = [],
  onWorksBreakdownChange,
}: ListingWorksProps) {
  const normalizedEstimatedBudget = normalizeBudget(estimatedBudget);
  const risks = workRisks(sale);
  const firstRisk = risks[0];
  const scenarioSurface = surface != null && surface > 0 ? surface : null;
  const selectedScenario = worksScenarioForAmount(scenarioSurface, normalizedEstimatedBudget ?? 0);
  const selectedScenarioConfig = WORKS_SCENARIOS.find((item) => item.key === selectedScenario);
  const showScenarioPicker = scenarioSurface != null && onScenarioSelect != null;
  const condition = useMemo(() => saleCondition(sale), [sale]);
  const dpeClass = useMemo(() => buildDpeAnalysis(sale).class, [sale]);
  const suggestion = suggestWorksScenario(condition, dpeClass);
  const dpeNote = dpeRentalNote(dpeClass);
  const budgetLabel =
    normalizedEstimatedBudget == null
      ? "Données insuffisantes"
      : normalizedEstimatedBudget === 0
        ? "Aucun travaux"
        : selectedScenarioConfig
          ? selectedScenarioConfig.label
          : "Montant personnalisé";
  const budgetNote =
    normalizedEstimatedBudget == null
      ? "Aucune enveloppe disponible dans cette fiche. Ajoutez des postes vérifiés pour créer votre hypothèse."
      : normalizedEstimatedBudget === 0
        ? showScenarioPicker
          ? "Aucun budget retenu : choisissez un scénario ci-dessus ou détaillez vos postes."
          : "Aucun budget retenu dans cette simulation."
        : selectedScenarioConfig && scenarioSurface
          ? `Estimation : ${new Intl.NumberFormat("fr-FR").format(scenarioSurface)} m² × ${formatPrice(selectedScenarioConfig.pricePerM2)}/m², à confirmer lors de la visite.`
          : "Enveloppe de simulation à confirmer lors de la visite.";
  const exceedsEnvelope =
    maxWorks != null &&
    normalizedEstimatedBudget != null &&
    normalizedEstimatedBudget > Math.max(0, maxWorks);

  const selectScenario = (scenario: (typeof WORKS_SCENARIOS)[number]["key"] | null) => {
    if (!onScenarioSelect || scenarioSurface == null) return;
    onScenarioSelect(scenario ? estimateWorksBudget(scenarioSurface, scenario) : 0);
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
              {normalizedEstimatedBudget != null
                ? formatPrice(normalizedEstimatedBudget)
                : "Non estimé"}
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

        {onWorksBreakdownChange ? (
          <WorksBreakdownPanel
            items={worksBreakdown}
            onChange={(items) =>
              onWorksBreakdownChange(items, summarizeWorksBreakdown(items).total)
            }
          />
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
                  elle reste à confirmer après la visite du bien.
                </p>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>
    </section>
  );
}
