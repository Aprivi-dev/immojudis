"use client";

import { useState } from "react";
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
import { LandParcelDiagram } from "./LandParcelDiagram";
import styles from "./LandPotentialPanel.module.css";
import { userMessage } from "@/lib/user-messages";

type Props = { saleId: string; enabled: boolean; initialReport?: LandReport };
const PROJECT_LABELS: Record<LandProjectKind, string> = {
  extension: "Agrandir",
  height: "Surélever",
  construction: "Construire",
  division: "Diviser le terrain",
  destination: "Changer de destination",
};

export function LandPotentialPanel({ saleId, enabled, initialReport }: Props) {
  const [report, setReport] = useState(initialReport ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [projectKind, setProjectKind] = useState<LandProjectKind>("extension");

  async function load(refresh = false) {
    setLoading(true);
    setError(null);
    try {
      setReport(await fetchSaleLandReport(saleId, refresh));
    } catch (cause) {
      setError(userMessage(cause, "Les sources n’ont pas pu être consultées."));
    } finally {
      setLoading(false);
    }
  }

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

  const selectedProject = report?.projects.find((project) => project.kind === projectKind);
  const checks = report
    ? [...report.planning.checks, ...report.risks.checks, ...report.rules.checks]
    : [];
  const unavailableCount = checks.filter((check) => check.status === "unavailable").length;
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
    <section className={styles.root} aria-label="Potentiel de construction et risques du bien">
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
            <button
              className={styles.primaryButton}
              type="button"
              disabled={loading}
              onClick={() => void load(Boolean(report))}
            >
              {report ? <RefreshCw size={16} aria-hidden="true" /> : null}
              {loading
                ? "Consultation des sources…"
                : report
                  ? "Actualiser les sources"
                  : "Consulter le PLU et les risques"}
            </button>
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
          {loading ? (
            <p className={styles.loading} role="status">
              Recherche cadastrale, consultation des cartes et lecture du règlement. Cette
              vérification peut prendre un peu de temps.
            </p>
          ) : null}
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          {report ? (
            <div className={styles.report}>
              <p className={styles.timestamp}>
                Vérifié le {formatDate(report.generatedAt)}
                {unavailableCount > 0
                  ? ` · ${unavailableCount} source${unavailableCount > 1 ? "s" : ""} indisponible${unavailableCount > 1 ? "s" : ""}`
                  : ""}
              </p>
              <section className={styles.section} aria-label="Parcelles et zonage officiel">
                <h4>Parcelles et zonage</h4>
                <p className={styles.caption}>
                  {report.planning.locationStatus === "references_matched"
                    ? "Références retrouvées au cadastre. Le périmètre de la vente reste à recouper avec le cahier des conditions."
                    : report.planning.locationStatus === "point_candidate"
                      ? "Parcelle candidate autour du point d’adresse. Le rattachement au bien reste à confirmer."
                      : report.planning.locationStatus === "ambiguous"
                        ? "Plusieurs rattachements ou zones sont à examiner. Les règles ne sont pas généralisées à tout le terrain."
                        : "La parcelle n’a pas pu être rattachée avec les informations disponibles."}
                </p>
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
                              ? "Point d’adresse · à confirmer"
                              : "Référence cadastrale · à recouper"}
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
                    Aucun zonage n’a été identifié dans les couches consultées. Vérifiez le document
                    applicable et la couverture des sources ci-dessous.
                  </p>
                )}
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
                {!report.rules.completeCoverage ? (
                  <p className={styles.attention}>
                    Lecture partielle du règlement. Les extraits ci-dessous ne couvrent pas toutes
                    les dispositions, annexes et exceptions applicables.
                  </p>
                ) : null}
                <label className={styles.projectLabel} htmlFor={`land-project-${saleId}`}>
                  Votre projet
                </label>
                <select
                  id={`land-project-${saleId}`}
                  className={styles.select}
                  value={projectKind}
                  onChange={(event) => setProjectKind(event.target.value as LandProjectKind)}
                >
                  {Object.entries(PROJECT_LABELS).map(([kind, label]) => (
                    <option value={kind} key={kind}>
                      {label}
                    </option>
                  ))}
                </select>
                {selectedProject ? (
                  <>
                    <p className={styles.projectSummary}>{selectedProject.summary}</p>
                    {selectedProject.rules.length ? (
                      <RuleGroups key={projectKind} rules={selectedProject.rules} />
                    ) : (
                      <p className={styles.notice}>
                        Les articles n’ont pas pu être lus automatiquement pour ce projet. Les
                        documents officiels restent accessibles ci-dessus.
                      </p>
                    )}
                    <div className={styles.checkGrid}>
                      <div>
                        <h5>Conditions à examiner</h5>
                        <ul>
                          {selectedProject.checks.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <h5>Informations à obtenir</h5>
                        <ul>
                          {selectedProject.missingInformation.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </>
                ) : null}
                <p className={styles.caption}>
                  Une règle repérée doit être lue avec ses exceptions, les dispositions générales,
                  les OAP et les servitudes. Le projet nécessite l’autorisation applicable.
                </p>
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
                  <p className={styles.caption}>
                    Aucun enregistrement dans les couches consultées. La couverture et les sources
                    indisponibles sont détaillées ci-dessous.
                  </p>
                )}
              </section>

              <section className={styles.section} aria-label="Risques liés à l’emplacement">
                <h4>Risques liés à l’emplacement</h4>
                <p className={styles.caption}>
                  La portée géographique et les limites de chaque donnée sont conservées. Un
                  historique communal ne prouve pas un sinistre de ce bâtiment.
                </p>
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
                <summary>Couverture, dates et limites des sources</summary>
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
