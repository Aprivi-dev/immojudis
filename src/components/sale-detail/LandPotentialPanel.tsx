"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.js";
import Download from "lucide-react/dist/esm/icons/download.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert.js";
import { fetchSaleLandReport, downloadSaleLandReport } from "@/lib/land-report-client";
import { LAND_SCOPE_LABELS, LAND_SOURCE_STATUS_LABELS } from "@/lib/land-report-export";
import { safeExternalHttpUrl } from "@/lib/external-url";
import type {
  LandProjectKind,
  LandReport,
  LandSourceCheck,
  LandRiskFinding,
  LandRiskCategory,
  LandRuleEvidence,
} from "@/lib/land-report-types";
import {
  compareListingZone,
  landReportReliability,
  parcelSurfaceGap,
  rulesUnavailableReason,
} from "@/lib/land-report-coherence";
import { LandParcelDiagram } from "./LandParcelDiagram";
import styles from "./LandPotentialPanel.module.css";
import { userMessage } from "@/lib/user-messages";

type Props = {
  saleId: string;
  enabled: boolean;
  initialReport?: LandReport;
  /** PLU zone quoted in the listing (« UP1*1L40 »), compared with the official zone. */
  listingZone?: string | null;
  /** Land surface announced, compared with the parcels found. */
  landSurfaceM2?: number | null;
  /** Shares the report with the cadastral plan, which outlines the parcels found. */
  onReport?: (report: LandReport | null) => void;
};
const PROJECT_LABELS: Record<LandProjectKind, string> = {
  extension: "Agrandir",
  height: "Surélever",
  construction: "Construire",
  division: "Diviser le terrain",
  destination: "Changer de destination",
};

export function LandPotentialPanel({
  saleId,
  enabled,
  initialReport,
  listingZone = null,
  landSurfaceM2 = null,
  onReport,
}: Props) {
  const rootRef = useRef<HTMLElement | null>(null);
  const autoLoadStarted = useRef(false);
  const [report, setReport] = useState(initialReport ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [projectKind, setProjectKind] = useState<LandProjectKind | null>(null);

  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      setError(null);
      try {
        setReport(await fetchSaleLandReport(saleId, refresh));
      } catch (cause) {
        setError(userMessage(cause, "Les sources n’ont pas pu être consultées."));
      } finally {
        setLoading(false);
      }
    },
    [saleId],
  );

  // The report is read as soon as the panel comes near the screen: no button to find.
  useEffect(() => {
    if (!enabled || initialReport || autoLoadStarted.current) return;
    const start = () => {
      if (autoLoadStarted.current) return;
      autoLoadStarted.current = true;
      void load(false);
    };
    const node = rootRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      start();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          start();
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, initialReport, load]);

  useEffect(() => {
    onReport?.(report);
  }, [onReport, report]);

  async function exportReport() {
    setExporting(true);
    setError(null);
    try {
      await downloadSaleLandReport(saleId);
    } catch (cause) {
      setError(userMessage(cause, "L’export est indisponible."));
    } finally {
      setExporting(false);
    }
  }

  // A project is offered only when at least one article of the zone speaks to it.
  const usefulProjects = report?.projects.filter((project) => project.rules.length > 0) ?? [];
  const selectedProject =
    usefulProjects.find((project) => project.kind === projectKind) ?? usefulProjects[0];
  const reliability = report ? landReportReliability(report.planning) : null;
  const checks = report
    ? [...report.planning.checks, ...report.risks.checks, ...report.rules.checks]
    : [];
  const unavailableCount = checks.filter((check) => check.status === "unavailable").length;
  const surfaceGap = report ? parcelSurfaceGap(report.planning.parcels, landSurfaceM2) : null;
  const zoneCheck = report ? compareListingZone(listingZone, report.planning.zones) : null;
  const warnings = report
    ? [
        ...new Set([
          ...report.planning.warnings,
          ...report.risks.warnings,
          ...report.rules.warnings,
        ]),
      ]
    : [];

  return (
    <section
      ref={rootRef}
      className={styles.root}
      aria-label="Potentiel de construction et risques du bien"
    >
      <div className={styles.header}>
        <div>
          <p className={styles.eyebrow}>PLU et risques · sources officielles</p>
          <h3>Quel projet envisager sur ce bien ?</h3>
          <p className={styles.intro}>
            Parcelles, règles d’urbanisme, servitudes et risques liés au terrain, avec les documents
            pour comprendre leurs conséquences.
          </p>
        </div>
        <ShieldAlert aria-hidden="true" size={23} />
      </div>

      {!enabled ? (
        <div className={styles.notice}>
          <p>L’offre Analyse donne accès au dossier PLU et risques de chaque annonce.</p>
          <a href="/offres">
            Découvrir l’offre Analyse <ArrowUpRight size={15} aria-hidden="true" />
          </a>
        </div>
      ) : (
        <>
          <div className={styles.actions}>
            {report || error ? (
              <button
                className={report ? styles.secondaryButton : styles.primaryButton}
                type="button"
                disabled={loading}
                onClick={() => void load(Boolean(report))}
              >
                <RefreshCw size={16} aria-hidden="true" />
                {loading
                  ? "Consultation des sources…"
                  : report
                    ? "Actualiser les sources"
                    : "Réessayer"}
              </button>
            ) : null}
            {report ? (
              <button
                className={styles.secondaryButton}
                type="button"
                disabled={loading || exporting}
                onClick={() => void exportReport()}
              >
                <Download size={16} aria-hidden="true" />{" "}
                {exporting ? "Préparation du PDF…" : "Exporter le dossier PDF"}
              </button>
            ) : null}
          </div>
          {loading || (!report && !error) ? (
            <p className={styles.loading} role="status">
              Recherche de la parcelle, du zonage et des risques, puis lecture du règlement :
              environ 15 secondes.
            </p>
          ) : null}
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          {report ? (
            <div className={styles.report}>
              {reliability ? (
                <p className={styles.reliability} data-tone={reliability.tone}>
                  <strong>{reliability.text}</strong>
                  <span>
                    Vérifié le {formatDate(report.generatedAt)}
                    {unavailableCount > 0
                      ? ` · ${unavailableCount} source${unavailableCount > 1 ? "s" : ""} indisponible${unavailableCount > 1 ? "s" : ""}`
                      : ""}
                  </span>
                </p>
              ) : null}
              <section className={styles.section} aria-label="Parcelles et zonage officiel">
                <h4>Parcelles et zonage</h4>
                {surfaceGap ? <p className={styles.attention}>{surfaceGap}</p> : null}
                {report.planning.parcels.length ? (
                  <>
                    <LandParcelDiagram
                      parcels={report.planning.parcels}
                      zones={report.planning.zones}
                    />
                    <ul className={styles.cardGrid}>
                      {report.planning.parcels.map((parcel) => (
                        <li className={styles.card} key={parcel.id}>
                          <strong>
                            Section {parcel.section} n° {parcel.number}
                          </strong>
                          <span>
                            {parcel.city ?? parcel.codeInsee} ·{" "}
                            {parcel.surfaceM2 != null
                              ? `${new Intl.NumberFormat("fr-FR").format(parcel.surfaceM2)} m² au cadastre`
                              : "Surface non fournie"}
                          </span>
                          <small>
                            {parcel.match === "address_point"
                              ? "Trouvée d’après l’adresse"
                              : parcel.match === "listing_reference"
                                ? "Citée dans l’annonce"
                                : "Citée dans le dossier"}
                          </small>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {report.planning.zones.length ? (
                  <ul className={styles.cardGrid}>
                    {report.planning.zones.map((zone) => (
                      <li className={styles.card} key={zone.id}>
                        <strong>Zone {zone.label}</strong>
                        <span>{zone.description}</span>
                        <small>{zone.documentName}</small>
                        {zone.regulationUrl ? (
                          <SourceLink url={zone.regulationUrl} label="Lire le règlement" />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.notice}>
                    Aucun zonage n’a été identifié pour cette parcelle.
                  </p>
                )}
                {zoneCheck ? (
                  <p className={zoneCheck.matches === false ? styles.attention : styles.caption}>
                    Zone citée dans l’annonce : {zoneCheck.zone}
                    {zoneCheck.matches === true
                      ? " · concorde avec le zonage officiel."
                      : zoneCheck.matches === false
                        ? " · diffère du zonage officiel ci-dessus : à vérifier dans le cahier des conditions de vente."
                        : "."}
                  </p>
                ) : null}
                {report.planning.documents.map((document) => (
                  <details className={styles.document} key={document.id}>
                    <summary>{document.title || document.name}</summary>
                    <p>
                      Statut GPU : {document.legalStatus ?? "non renseigné"} ·{" "}
                      {document.effectiveStatus ?? "statut effectif non renseigné"}
                    </p>
                    <p>
                      Publié : {document.publicationDate ?? "date non fournie"} · mis à jour :{" "}
                      {document.updatedAt ?? "date non fournie"}
                    </p>
                    <SourceLink
                      url={document.sourceUrl}
                      label="Document et procédures sur le Géoportail"
                    />
                    <ul>
                      {document.files.map((file) => (
                        <li key={file.url}>
                          <SourceLink url={file.url} label={file.name} />
                        </li>
                      ))}
                    </ul>
                  </details>
                ))}
              </section>

              <section className={styles.section} aria-label="Projet et règles du PLU">
                <h4>Les règles utiles à votre projet</h4>
                {selectedProject ? (
                  <>
                    <label className={styles.projectLabel} htmlFor={`land-project-${saleId}`}>
                      Votre projet
                    </label>
                    <select
                      id={`land-project-${saleId}`}
                      className={styles.select}
                      value={selectedProject.kind}
                      onChange={(event) => setProjectKind(event.target.value as LandProjectKind)}
                    >
                      {usefulProjects.map((project) => (
                        <option value={project.kind} key={project.kind}>
                          {PROJECT_LABELS[project.kind]}
                        </option>
                      ))}
                    </select>
                    <RuleGroups key={selectedProject.kind} rules={selectedProject.rules} />
                    <details className={styles.coverage}>
                      <summary>Points à vérifier avant ce projet</summary>
                      <ul>
                        {[...selectedProject.checks, ...selectedProject.missingInformation].map(
                          (item) => (
                            <li key={item}>{item}</li>
                          ),
                        )}
                      </ul>
                    </details>
                  </>
                ) : (
                  <p className={styles.notice}>
                    {report.rules.rules.length
                      ? "Les articles lus ne portent sur aucun des projets proposés."
                      : rulesUnavailableReason(report.rules.checks)}{" "}
                    Les articles applicables se lisent dans le règlement de la zone ci-dessus.
                  </p>
                )}
                <SourceLink
                  url="https://www.service-public.gouv.fr/particuliers/vosdroits/F1633"
                  label="Préparer un certificat d’urbanisme opérationnel"
                />
              </section>

              <section className={styles.section} aria-label="Servitudes et prescriptions">
                <h4>Servitudes et prescriptions</h4>
                {report.planning.constraints.length ? (
                  <ul className={styles.cardGrid}>
                    {report.planning.constraints.map((constraint) => (
                      <li className={styles.card} key={constraint.id}>
                        <strong>{constraint.label}</strong>
                        {constraint.detail ? <span>{constraint.detail}</span> : null}
                        {constraint.isEnvelope ? (
                          <p className={styles.attention}>
                            Enveloppe repérée : le zonage réglementaire et les prescriptions à la
                            parcelle restent à déterminer.
                          </p>
                        ) : null}
                        <small>
                          {constraint.kind === "servitude"
                            ? "Servitude d’utilité publique"
                            : constraint.kind === "prescription"
                              ? "Prescription graphique"
                              : "Périmètre d’information"}{" "}
                          {constraint.typeCode ?? ""}
                        </small>
                        {constraint.documentUrl ? (
                          <SourceLink
                            url={constraint.documentUrl}
                            label="Consulter la pièce officielle"
                          />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.caption}>Aucune servitude ni prescription repérée.</p>
                )}
              </section>

              <section className={styles.section} aria-label="Risques liés à l’emplacement">
                <h4>Risques liés à l’emplacement</h4>
                {report.risks.findings.length ? (
                  <div className={styles.riskGroups}>
                    {groupRisks(report.risks.findings).map(([category, findings]) => (
                      <div key={category}>
                        <h5>{RISK_CATEGORY_LABELS[category]}</h5>
                        <ul className={styles.riskList}>
                          {findings.slice(0, 2).map((risk) => (
                            <RiskCard key={risk.id} risk={risk} />
                          ))}
                        </ul>
                        {findings.length > 2 ? (
                          <details className={styles.coverage}>
                            <summary>
                              Voir {findings.length - 2} autre{findings.length > 3 ? "s" : ""}{" "}
                              constat{findings.length > 3 ? "s" : ""} et événement
                              {findings.length > 3 ? "s" : ""}
                            </summary>
                            <ul className={styles.riskList}>
                              {findings.slice(2).map((risk) => (
                                <RiskCard key={risk.id} risk={risk} />
                              ))}
                            </ul>
                          </details>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className={styles.notice}>
                    Aucun constat exploitable n’a été retourné. Cela ne permet pas de conclure à
                    l’absence de risque.
                  </p>
                )}
              </section>

              <details className={styles.coverage}>
                <summary>Sources, dates et limites</summary>
                {!report.rules.completeCoverage ? (
                  <p className={styles.attention}>
                    Lecture partielle du règlement : les extraits ne couvrent pas toutes les
                    dispositions, annexes et exceptions applicables. Une règle repérée se lit avec
                    les dispositions générales, les OAP et les servitudes.
                  </p>
                ) : null}
                <ul className={styles.sourceChecks}>
                  {checks.map((check, index) => (
                    <SourceCheck key={`${check.key}-${index}`} check={check} />
                  ))}
                </ul>
                {warnings.length ? (
                  <ul className={styles.warnings}>
                    {warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                ) : null}
              </details>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function RuleGroups({ rules }: { rules: LandRuleEvidence[] }) {
  const groups = new Map<string, LandRuleEvidence[]>();
  for (const rule of rules) groups.set(rule.topic, [...(groups.get(rule.topic) ?? []), rule]);
  return (
    <div className={styles.ruleGroups}>
      {[...groups].map(([topic, entries]) => (
        <details
          className={styles.document}
          key={topic}
          open={topic === "footprint" || topic === "height"}
        >
          <summary>
            {entries[0].title} · {entries.length} extrait{entries.length > 1 ? "s" : ""}
          </summary>
          <ul className={styles.ruleList}>
            {entries.slice(0, 2).map((rule) => (
              <RuleCard key={rule.id} rule={rule} />
            ))}
          </ul>
          {entries.length > 2 ? (
            <details className={styles.coverage}>
              <summary>Lire les {entries.length - 2} autres extraits et conditions</summary>
              <ul className={styles.ruleList}>
                {entries.slice(2).map((rule) => (
                  <RuleCard key={rule.id} rule={rule} />
                ))}
              </ul>
            </details>
          ) : null}
        </details>
      ))}
    </div>
  );
}
function RuleCard({ rule }: { rule: LandRuleEvidence }) {
  return (
    <li className={styles.rule}>
      <div className={styles.cardTop}>
        <strong>{rule.title}</strong>
        <span>Page PDF {rule.page}</span>
      </div>
      <p className={styles.ruleMeta}>
        {rule.zoneLabels.join(" · ")}
        {rule.article ? ` · ${rule.article}` : ""}
      </p>
      <blockquote>{rule.text}</blockquote>
      {rule.conditions.length ? (
        <ul>
          {rule.conditions.map((condition) => (
            <li key={condition}>{condition}</li>
          ))}
        </ul>
      ) : null}
      <SourceLink
        url={`${rule.sourceUrl.split("#")[0]}#page=${rule.page}`}
        label="Vérifier l’article dans le document"
      />
    </li>
  );
}

const RISK_CATEGORY_LABELS: Record<LandRiskCategory, string> = {
  flood: "Inondations et ruissellement",
  fire: "Incendie et débroussaillement",
  clay: "Argiles",
  ground_movement: "Mouvements de terrain",
  cavity_mining: "Cavités et mines",
  pollution: "Pollution et anciens sites",
  technological: "Risques technologiques",
  earthquake: "Séisme",
  radon: "Radon",
  coastal: "Littoral",
  other: "Autres plans et risques",
};
function groupRisks(findings: LandRiskFinding[]): [LandRiskCategory, LandRiskFinding[]][] {
  return (Object.keys(RISK_CATEGORY_LABELS) as LandRiskCategory[])
    .map((category): [LandRiskCategory, LandRiskFinding[]] => [
      category,
      findings.filter((risk) => risk.category === category),
    ])
    .filter(([, risks]) => risks.length > 0);
}
function RiskCard({ risk }: { risk: LandRiskFinding }) {
  return (
    <li className={styles.risk}>
      <div className={styles.cardTop}>
        <strong>{risk.label}</strong>
        <span className={styles.scope}>{LAND_SCOPE_LABELS[risk.scope]}</span>
      </div>
      {risk.level ? <p className={styles.level}>{risk.level}</p> : null}
      <p>{risk.description}</p>
      {risk.consequences.length ? (
        <div className={styles.consequences}>
          <h5>Conséquences à vérifier</h5>
          <ul>
            {risk.consequences.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className={styles.ruleMeta}>
        {risk.sourceLabel} · millésime {risk.vintage ?? "non renseigné"}
        {risk.sourceUpdatedAt ? ` · source mise à jour le ${formatDate(risk.sourceUpdatedAt)}` : ""}
        {risk.precision ? ` · ${risk.precision}` : ""}
        {risk.distanceM != null ? ` · distance indicative ${Math.round(risk.distanceM)} m` : ""}
      </p>
      <SourceLink url={risk.sourceUrl} label="Consulter la source du risque" />
      {risk.documentUrls?.map((doc) => (
        <SourceLink key={doc.url} url={doc.url} label={doc.label} />
      ))}
    </li>
  );
}

function SourceCheck({ check }: { check: LandSourceCheck }) {
  return (
    <li>
      <strong>{check.label}</strong>
      <span>
        {LAND_SOURCE_STATUS_LABELS[check.status]} · {LAND_SCOPE_LABELS[check.scope]}
      </span>
      {check.message ? <p>{check.message}</p> : null}
      <small>
        Consulté le {formatDate(check.checkedAt)}
        {check.version ? ` · ${check.version}` : ""}
        {check.sourceUpdatedAt
          ? ` · source mise à jour le ${formatDate(check.sourceUpdatedAt)}`
          : ""}
      </small>
      <SourceLink url={check.sourceUrl} label="Source officielle" />
    </li>
  );
}

function SourceLink({ url, label }: { url: string; label: string }) {
  const safeUrl = safeExternalHttpUrl(url);
  return safeUrl ? (
    <a className={styles.sourceLink} href={safeUrl} target="_blank" rel="noopener noreferrer">
      {label} <ArrowUpRight size={14} aria-hidden="true" />
    </a>
  ) : null;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("fr-FR", { timeZone: "Europe/Paris" })
    : value;
}
