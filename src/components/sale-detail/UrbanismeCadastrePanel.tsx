"use client";

import { useMemo, type ReactNode } from "react";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.js";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert.js";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import Info from "lucide-react/dist/esm/icons/info.js";
import LandPlot from "lucide-react/dist/esm/icons/land-plot.js";
import Map from "lucide-react/dist/esm/icons/map.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import SearchCheck from "lucide-react/dist/esm/icons/search-check.js";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert.js";
import type { AuctionSale, SaleRisk } from "@/lib/types";
import type { CadastralNeighborhoodPoint } from "@/lib/cadastre-neighborhood";
import {
  buildCadastralAnalysis,
  formatCadastralReference,
  type StructuredCadastralParcel,
} from "@/lib/cadastre-analysis";
import {
  buildUrbanPlanningAnalysis,
  type StructuredUrbanPlanningSignal,
  type UrbanPlanningItem,
} from "@/lib/urban-planning-analysis";
import { safeExternalHttpUrl } from "@/lib/external-url";
import { CadastralPlanDisclosure } from "./CadastralPlanDisclosure";
import { LandPotentialPanel } from "./LandPotentialPanel";
import styles from "./UrbanismeCadastrePanel.module.css";

export type UrbanismeCadastrePanelProps = {
  sale: AuctionSale;
  /** Address point used for indicative mapping, including an unconfirmed location. */
  mapLocation?: Pick<AuctionSale, "address" | "postal_code" | "city" | "latitude" | "longitude">;
  /** Optional API Carto parcel matches supplied by the server or report loader. */
  cadastralParcels?: StructuredCadastralParcel[];
  /** Optional structured PLU / permit / servitude signals supplied by the report loader. */
  urbanPlanningSignals?: StructuredUrbanPlanningSignal[];
  officialLandEnabled?: boolean;
  className?: string;
  heading?: string;
};

type Coordinates = CadastralNeighborhoodPoint;

const OFFICIAL_SOURCES = [
  {
    label: "Géoportail de l’urbanisme",
    href: "https://www.geoportail-urbanisme.gouv.fr/",
  },
  {
    label: "Cadastre.gouv.fr",
    href: "https://www.cadastre.gouv.fr/scpc/accueil.do",
  },
  {
    label: "Géorisques",
    href: "https://www.georisques.gouv.fr/",
  },
] as const;

const URBAN_RISK_TERMS =
  /urban|plu|zonage|zone|servitude|passage|cadastre|parcell|inond|submersion|argile|sism|permis|autorisation|conform|destination|copropri|pollution|nuisance|retrait|gonflement|erp/i;

type CadastralAnalysis = ReturnType<typeof buildCadastralAnalysis>;
type UrbanPlanningAnalysis = ReturnType<typeof buildUrbanPlanningAnalysis>;

export function UrbanismeCadastrePanel({
  sale,
  mapLocation = sale,
  cadastralParcels = [],
  urbanPlanningSignals = [],
  officialLandEnabled = false,
  className,
  heading = "Urbanisme & cadastre",
}: UrbanismeCadastrePanelProps) {
  const cadastral = useMemo(
    () => buildCadastralAnalysis(sale, cadastralParcels),
    [cadastralParcels, sale],
  );
  const urbanPlanning = useMemo(
    () =>
      buildUrbanPlanningAnalysis({
        sale,
        documents: sale.documents_rich ?? [],
        risks: sale.risks ?? [],
        structuredSignals: urbanPlanningSignals,
      }),
    [sale, urbanPlanningSignals],
  );
  const relevantRisks = useMemo(() => selectUrbanRisks(sale.risks ?? []), [sale.risks]);
  const coordinates = useMemo(
    () => resolveCoordinates(mapLocation, cadastral.structuredParcels),
    [cadastral.structuredParcels, mapLocation],
  );

  const rootClassName = [styles.panel, className].filter(Boolean).join(" ");
  const addressSummary = locationSummary(sale);
  const primaryAction = firstNextAction(cadastral, urbanPlanning);

  return (
    <section className={rootClassName} aria-labelledby="urbanisme-cadastre-heading">
      <header className={styles.header}>
        <div className={styles.headingGroup}>
          <h2 id="urbanisme-cadastre-heading" className={styles.title}>
            {heading}
          </h2>
          <p className={styles.intro}>
            Repérage indicatif de la parcelle et des règles applicables, à confirmer dans les
            sources officielles.
          </p>
        </div>
        <div className={styles.headerMark} aria-hidden="true">
          <LandPlot size={24} strokeWidth={1.8} />
        </div>
      </header>

      <div className={styles.compactSummary}>
        <div className={styles.compactSummaryLead}>
          <div className={styles.compactSummaryIcon} aria-hidden="true">
            <SearchCheck size={17} />
          </div>
          <div>
            <p className={styles.compactSummaryLabel}>{compactStatusLabel(sale, cadastral)}</p>
            <p className={styles.compactSummaryText}>{primaryAction}</p>
          </div>
        </div>
        <p className={styles.compactSummaryCaveat}>
          L’adresse est un point de départ. Elle ne suffit pas à confirmer une parcelle ni les
          règles d’urbanisme.
        </p>
      </div>

      <LandPotentialPanel key={sale.id} saleId={sale.id} enabled={officialLandEnabled} />

      <CadastralPlanDisclosure
        point={coordinates}
        streetAddress={displayText(mapLocation.address)}
        displayAddress={locationSummary(mapLocation)}
        postalCode={displayText(mapLocation.postal_code)}
        city={displayText(mapLocation.city)}
      />

      <details className={styles.details}>
        <summary className={styles.detailsSummary}>
          <span className={styles.detailsSummaryText}>
            <Info size={16} aria-hidden="true" />
            <span>
              <strong>Voir les références et contrôles</strong>
              <small>Adresse · parcelle · PLU · risques · sources</small>
            </span>
          </span>
          <ChevronDown className={styles.detailsChevron} size={18} aria-hidden="true" />
        </summary>

        <div className={styles.detailsContent}>
          <div className={styles.locationSummary}>
            <MapPin size={18} aria-hidden="true" />
            <div>
              <span className={styles.locationLabel}>Adresse fournie</span>
              <p className={styles.locationValue}>{addressSummary ?? "Adresse non fournie"}</p>
              <p className={styles.locationMeta}>{locationMeta(sale)}</p>
              <p className={styles.locationCaveat}>
                Une adresse ou un point géocodé ne délimite pas à lui seul une parcelle.
              </p>
            </div>
          </div>

          <section className={styles.section} aria-labelledby="urbanisme-cadastre-cadastre">
            <SectionHeading
              id="urbanisme-cadastre-cadastre"
              icon={<Map size={19} aria-hidden="true" />}
              title="Cadastre"
              intro={cadastral.summary}
              badge={
                <StatusBadge tone={statusTone(cadastral.status, cadastral.confidenceLabel)}>
                  {cadastral.confidenceLabel}
                </StatusBadge>
              }
            />
            <div className={styles.detailGrid}>
              <div>
                {cadastral.references.length > 0 ? (
                  <ul className={styles.referenceList} aria-label="Références cadastrales">
                    {cadastral.references.map((reference) => (
                      <li key={`${reference.raw}-${reference.source}`} className={styles.reference}>
                        <div className={styles.referenceTop}>
                          <p className={styles.referenceTitle}>
                            {formatCadastralReference(reference)}
                          </p>
                          <StatusBadge
                            tone={reference.confidence === "structured" ? "good" : "watch"}
                          >
                            {referenceConfidenceLabel(reference.confidence, reference.source)}
                          </StatusBadge>
                        </div>
                        <p className={styles.referenceSource}>Source : {reference.source}</p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState>
                    Aucune référence section / numéro n’est disponible. La surface terrain seule ne
                    permet pas d’identifier une parcelle.
                  </EmptyState>
                )}
                {cadastral.structuredParcels.length > 0 ? (
                  <div className={styles.subsection}>
                    <h4 className={styles.subheading}>Résultats API Carto</h4>
                    <ul className={styles.referenceList} aria-label="Parcelles API Carto">
                      {cadastral.structuredParcels.map((parcel, index) => (
                        <li
                          key={`${parcel.parcelKey ?? parcel.parcelId ?? "parcel"}-${index}`}
                          className={styles.reference}
                        >
                          <div className={styles.referenceTop}>
                            <p className={styles.referenceTitle}>{parcelTitle(parcel)}</p>
                            {isPointIntersectionMatch(parcel.matchKind) ? (
                              <StatusBadge tone="watch">Point géocodé · à recouper</StatusBadge>
                            ) : parcel.confidence != null ? (
                              <StatusBadge tone={parcel.confidence >= 0.8 ? "good" : "watch"}>
                                Confiance {Math.round(parcel.confidence * 100)} %
                              </StatusBadge>
                            ) : null}
                          </div>
                          <p className={styles.referenceSource}>
                            {[
                              parcel.city,
                              parcel.codeInsee,
                              parcel.surfaceM2 != null ? formatSurface(parcel.surfaceM2) : null,
                            ]
                              .filter(Boolean)
                              .join(" · ") || "Surface et commune non précisées"}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
              <div className={styles.sideStack}>
                <LocationNote coordinates={coordinates} />
                <DocumentsBlock documents={cadastral.documents} />
              </div>
            </div>
            <ActionList heading="À vérifier" actions={cadastral.nextActions} />
          </section>

          <section className={styles.section} aria-labelledby="urbanisme-cadastre-plu">
            <SectionHeading
              id="urbanisme-cadastre-plu"
              icon={<LandPlot size={19} aria-hidden="true" />}
              title="PLU, permis et usages"
              intro="Les éléments sont classés selon leur présence dans une pièce ou leur détection dans les sources collectées."
              badge={
                <StatusBadge tone={statusTone(urbanPlanning.status)}>
                  {urbanPlanning.confidenceLabel}
                </StatusBadge>
              }
            />
            {urbanPlanning.items.length > 0 ? (
              <ul className={styles.itemList} aria-label="Signaux urbanisme">
                {urbanPlanning.items.map((item) => (
                  <UrbanItemCard key={item.key} item={item} />
                ))}
              </ul>
            ) : (
              <EmptyState>
                Aucun signal PLU, permis, servitude, copropriété ou usage n’est rattaché aux sources
                collectées. Consultez le document d’urbanisme opposable de la commune et le cahier
                des conditions.
              </EmptyState>
            )}
            {urbanPlanning.missingChecks.length > 0 ? (
              <ActionList heading="Contrôles manquants" actions={urbanPlanning.missingChecks} />
            ) : null}
          </section>

          <section className={styles.section} aria-labelledby="urbanisme-cadastre-risques">
            <SectionHeading
              id="urbanisme-cadastre-risques"
              icon={<ShieldAlert size={19} aria-hidden="true" />}
              title="Risques et signaux fonciers"
              intro="Les points ci-dessous viennent des risques déjà rattachés au dossier et restent à qualifier dans les pièces officielles."
            />
            {relevantRisks.length > 0 ? (
              <ul className={styles.riskList} aria-label="Risques fonciers">
                {relevantRisks.map((risk, index) => (
                  <RiskCard key={`${risk.risk_type}-${risk.risk_label}-${index}`} risk={risk} />
                ))}
              </ul>
            ) : (
              <EmptyState>
                {(sale.risks ?? []).length > 0
                  ? "Les risques présents dans le dossier ne portent pas explicitement sur l’urbanisme, le cadastre ou l’environnement dans les informations disponibles ici."
                  : "Aucun risque urbanisme / foncier n’est rattaché aux sources collectées. Cela ne vaut pas absence de risque."}
              </EmptyState>
            )}
          </section>

          <section className={styles.section} aria-labelledby="urbanisme-cadastre-sources">
            <SectionHeading
              id="urbanisme-cadastre-sources"
              icon={<ExternalLink size={18} aria-hidden="true" />}
              title="Sources officielles"
              intro="À consulter pour confirmer le zonage, la parcelle et les risques autour du bien."
            />
            <ul className={styles.sourceList}>
              {OFFICIAL_SOURCES.map((source) => (
                <li key={source.href}>
                  <a
                    className={styles.sourceLink}
                    href={source.href}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {source.label} <ExternalLink size={13} aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
          </section>

          <p className={styles.footnote}>
            Une mention, un rattachement géographique ou une pièce repérée ne vaut pas validation
            juridique. Confirmez le zonage, les limites, les servitudes et les autorisations dans
            les sources officielles et le cahier des conditions de vente.
          </p>
        </div>
      </details>
    </section>
  );
}

function SectionHeading({
  id,
  icon,
  title,
  intro,
  badge,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  intro: string;
  badge?: ReactNode;
}) {
  return (
    <div className={styles.sectionHeader}>
      <div className={styles.sectionHeadingLine}>
        {icon}
        <h3 id={id} className={styles.sectionHeading}>
          {title}
        </h3>
        {badge}
      </div>
      <p className={styles.sectionIntro}>{intro}</p>
    </div>
  );
}

function hasAddress(sale: AuctionSale): boolean {
  return Boolean(displayText(sale.address));
}

function compactStatusLabel(sale: AuctionSale, analysis: CadastralAnalysis): string {
  if (analysis.references.length > 0 || analysis.structuredParcels.length > 0) {
    return "Référence cadastrale à recouper";
  }
  if (!hasAddress(sale)) {
    return displayText(sale.city)
      ? "Commune connue · parcelle à rattacher"
      : "Localisation à confirmer";
  }
  return "Adresse fournie · parcelle à rattacher";
}

function locationSummary(
  sale: Pick<AuctionSale, "address" | "postal_code" | "city">,
): string | null {
  const address = displayText(sale.address);
  const locality = [displayText(sale.postal_code), displayText(sale.city)]
    .filter(Boolean)
    .join(" ");
  if (address && locality) return `${address}, ${locality}`;
  return address ?? locality ?? null;
}

function locationMeta(sale: AuctionSale): string {
  const city = displayText(sale.city);
  const department = displayText(sale.department);
  if (city && department) return `${city} · ${department}`;
  if (city) return city;
  if (department) return department;
  return "Localisation à confirmer";
}

function firstNextAction(
  cadastral: CadastralAnalysis,
  urbanPlanning: UrbanPlanningAnalysis,
): string {
  if (cadastral.references.length > 0) {
    return "Confirmer la section et le numéro dans le plan cadastral officiel.";
  }
  if (cadastral.documents.length > 0) {
    return "Extraire la section et le numéro depuis la pièce cadastrale.";
  }
  if (cadastral.landSurfaceM2 != null) {
    return "Rattacher la surface terrain à une parcelle officielle.";
  }
  return urbanPlanning.nextActions[0] ?? "Rattacher l’adresse à une parcelle, puis la recouper.";
}

function displayText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || /^(?:n\.? ?c\.?|non renseign[ée]e?|inconnu|à confirmer)$/i.test(text)) {
    return null;
  }
  return text;
}

function UrbanItemCard({ item }: { item: UrbanPlanningItem }) {
  return (
    <li className={styles.urbanItem}>
      <div className={styles.itemTop}>
        <div>
          <p className={styles.itemTitle}>{item.label}</p>
          <span className={styles.referenceSource}>{item.source}</span>
        </div>
        <StatusBadge tone={item.status === "documented" ? "good" : "watch"}>
          {item.status === "documented" ? "Documenté" : "À vérifier"}
        </StatusBadge>
      </div>
      <p className={styles.itemDetail}>{item.detail}</p>
      <p className={styles.itemAction}>
        <strong>Prochaine vérification :</strong> {item.action}
      </p>
      <span className={[styles.priority, priorityClass(item.priority)].filter(Boolean).join(" ")}>
        {priorityLabel(item.priority)}
      </span>
    </li>
  );
}

function RiskCard({ risk }: { risk: SaleRisk }) {
  const evidence = riskEvidenceText(risk);
  const source = riskSourceText(risk);
  return (
    <li className={styles.riskItem}>
      <div className={styles.itemTop}>
        <p className={styles.itemTitle}>
          {risk.risk_label || risk.risk_type || "Point de vigilance"}
        </p>
        <StatusBadge tone={(risk.severity ?? 0) >= 4 ? "danger" : "watch"}>
          {(risk.severity ?? 0) >= 4 ? "Prioritaire" : "À qualifier"}
        </StatusBadge>
      </div>
      <p className={styles.itemDetail}>{evidence}</p>
      {source ? <p className={styles.referenceSource}>Source : {source}</p> : null}
    </li>
  );
}

function LocationNote({ coordinates }: { coordinates: Coordinates | null }) {
  return (
    <div className={styles.locationCard}>
      <h4 className={styles.locationTitle}>
        <MapPin size={17} aria-hidden="true" />
        Point de localisation
      </h4>
      {coordinates ? (
        <>
          <p className={styles.locationText}>
            {coordinates.source}. Ce point sert uniquement au repérage et ne délimite pas une
            parcelle.
          </p>
          <p className={styles.coordinates}>
            {coordinates.lat.toFixed(6)}, {coordinates.lng.toFixed(6)}
          </p>
        </>
      ) : (
        <p className={styles.locationText}>
          Aucun point de coordonnées exploitable n’est disponible. L’adresse ou la parcelle doit
          d’abord être confirmée.
        </p>
      )}
    </div>
  );
}

function DocumentsBlock({ documents }: { documents: CadastralAnalysis["documents"] }) {
  return (
    <div className={styles.subsection}>
      <h4 className={styles.subheading}>
        <FileText size={17} aria-hidden="true" />
        Pièces cadastrales
      </h4>
      {documents.length > 0 ? (
        <ul className={styles.documentList}>
          {documents.map((document) => {
            const href = safeExternalHttpUrl(document.url);
            return (
              <li key={`${document.label}-${document.url ?? ""}`} className={styles.documentItem}>
                <FileText size={15} aria-hidden="true" />
                <div>
                  {href ? (
                    <a className={styles.documentLink} href={href} target="_blank" rel="noreferrer">
                      {document.label} <ExternalLink size={13} aria-hidden="true" />
                    </a>
                  ) : (
                    <span className={styles.documentLink}>{document.label}</span>
                  )}
                  {document.type ? (
                    <span className={styles.documentMeta}>{document.type}</span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={styles.empty}>
          Aucun plan ou document cadastral n’est repéré dans le dossier.
        </p>
      )}
    </div>
  );
}

function ActionList({ heading, actions }: { heading: string; actions: string[] }) {
  const uniqueActions = uniqueStrings(actions);
  if (uniqueActions.length === 0) return null;
  return (
    <div className={styles.actionBlock}>
      <h4 className={styles.subheading}>
        <SearchCheck size={17} aria-hidden="true" />
        {heading}
      </h4>
      <ul className={styles.actionList}>
        {uniqueActions.map((action) => (
          <li key={action} className={styles.actionItem}>
            <ArrowUpRight size={14} aria-hidden="true" />
            <span>{action}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className={styles.empty}>
      <Info size={16} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

function StatusBadge({
  tone,
  children,
}: {
  tone: "good" | "watch" | "danger" | "missing";
  children: ReactNode;
}) {
  const Icon = tone === "good" ? CheckCircle2 : tone === "missing" ? Info : CircleAlert;
  const toneClass =
    tone === "good"
      ? styles.statusGood
      : tone === "danger"
        ? styles.statusDanger
        : tone === "watch"
          ? styles.statusWatch
          : styles.statusMissing;
  return (
    <span className={[styles.status, toneClass].filter(Boolean).join(" ")}>
      <Icon size={13} aria-hidden="true" />
      {children}
    </span>
  );
}

function resolveCoordinates(
  sale: Pick<AuctionSale, "latitude" | "longitude">,
  parcels: StructuredCadastralParcel[],
): Coordinates | null {
  const saleLat = sale.latitude;
  const saleLng = sale.longitude;
  if (isCoordinatePair(saleLat, saleLng) && typeof saleLng === "number") {
    return { lat: saleLat, lng: saleLng, source: "Coordonnées de l’annonce", kind: "listing" };
  }
  const parcel = parcels.find((item) => isCoordinatePair(item.centroidLat, item.centroidLng));
  const parcelLat = parcel?.centroidLat;
  const parcelLng = parcel?.centroidLng;
  if (parcel && isCoordinatePair(parcelLat, parcelLng) && typeof parcelLng === "number") {
    return {
      lat: parcelLat,
      lng: parcelLng,
      kind: "parcel-centroid",
      source: isPointIntersectionMatch(parcel.matchKind)
        ? "Point géocodé intersectant une parcelle"
        : "Centre de parcelle rattaché",
    };
  }
  return null;
}

function isCoordinatePair(
  lat: number | null | undefined,
  lng: number | null | undefined,
): lat is number {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

function selectUrbanRisks(risks: SaleRisk[]): SaleRisk[] {
  return risks.filter((risk) => {
    const occurrenceText = (risk.occurrences ?? [])
      .flatMap((item) => [item.document_label, item.document_type, item.excerpt])
      .filter(Boolean)
      .join(" ");
    const evidenceText =
      risk.evidence_json && typeof risk.evidence_json === "object"
        ? Object.values(risk.evidence_json as Record<string, unknown>)
            .filter((value) => typeof value === "string")
            .join(" ")
        : "";
    return URBAN_RISK_TERMS.test(
      `${risk.risk_type} ${risk.risk_label} ${risk.evidence ?? ""} ${occurrenceText} ${evidenceText}`,
    );
  });
}

function riskEvidenceText(risk: SaleRisk): string {
  if (risk.evidence?.trim()) return risk.evidence.trim();
  const firstOccurrence = risk.occurrences?.find((item) => item.excerpt?.trim());
  if (firstOccurrence?.excerpt?.trim()) return firstOccurrence.excerpt.trim();
  const evidence = risk.evidence_json;
  if (evidence && typeof evidence === "object") {
    const record = evidence as Record<string, unknown>;
    for (const key of ["why_it_matters", "reasoning", "fact", "question", "detail"]) {
      if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
    }
  }
  return "Signal repéré dans les données collectées ; extrait à confirmer dans la pièce source.";
}

function riskSourceText(risk: SaleRisk): string | null {
  const firstOccurrence = risk.occurrences?.find(
    (item) => item.document_label || item.document_type,
  );
  return firstOccurrence?.document_label ?? firstOccurrence?.document_type ?? null;
}

function parcelTitle(parcel: StructuredCadastralParcel): string {
  if (parcel.section || parcel.parcelNumber) {
    return `Section ${parcel.section ?? "?"} · parcelle ${parcel.parcelNumber ?? "?"}`;
  }
  return parcel.parcelId ?? parcel.parcelKey ?? "Parcelle rattachée";
}

function formatSurface(value: number): string {
  return `${Math.round(value).toLocaleString("fr-FR")} m²`;
}

function statusTone(status: string, confidenceLabel = ""): "good" | "watch" | "missing" {
  if (/à confirmer|à recouper/i.test(confidenceLabel)) return "watch";
  if (status === "identified" || status === "documented") return "good";
  if (status === "missing") return "missing";
  return "watch";
}

function isPointIntersectionMatch(matchKind: string | null): boolean {
  return (matchKind ?? "").trim().toLowerCase() === "point_intersection";
}

function referenceConfidenceLabel(
  confidence: "structured" | "direct" | "inferred",
  source = "",
): string {
  if (source.toLowerCase().includes("intersection du point géocodé")) {
    return "Point géocodé";
  }
  if (confidence === "structured") return "Structurée";
  if (confidence === "direct") return "Source directe";
  return "Déduite";
}

function priorityClass(priority: UrbanPlanningItem["priority"]): string {
  if (priority === "high") return styles.priorityHigh;
  if (priority === "medium") return styles.priorityMedium;
  return styles.priorityLow;
}

function priorityLabel(priority: UrbanPlanningItem["priority"]): string {
  if (priority === "high") return "Priorité haute";
  if (priority === "medium") return "À traiter";
  return "Contexte";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
