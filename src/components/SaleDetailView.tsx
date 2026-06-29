import { useEffect, useState } from "react";
import type * as React from "react";
import { Link, useRouter } from "@tanstack/react-router";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.js";
import BadgeEuro from "lucide-react/dist/esm/icons/badge-euro.js";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import CircleHelp from "lucide-react/dist/esm/icons/circle-help.js";
import ClipboardCheck from "lucide-react/dist/esm/icons/clipboard-check.js";
import Clock3 from "lucide-react/dist/esm/icons/clock-3.js";
import Download from "lucide-react/dist/esm/icons/download.js";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import FileCheck2 from "lucide-react/dist/esm/icons/file-check-2.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import Share2 from "lucide-react/dist/esm/icons/share-2.js";
import Target from "lucide-react/dist/esm/icons/target.js";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert.js";
import {
  formatPrice,
  formatDate,
  formatDateTime,
  documentTypeLabel,
  formatPricePerM2,
  occupancyLabel,
  propertyTypeLabel,
  saleStatusLabel,
} from "@/lib/format";
import { getDisplaySurface, getSaleSurface } from "@/lib/surface";
import { parseDocs } from "@/lib/documents";
import { DocumentsList } from "@/components/DocumentsList";
import { FavoriteButton } from "@/components/FavoriteButton";
import { BidCeilingAssistant } from "@/components/BidCeilingAssistant";
import { PropertyOverview } from "@/components/PropertyOverview";
import { SaleCountdown } from "@/components/SaleCountdown";
import { SaleLocationHero } from "@/components/SaleLocationHero";
import { BrandMark } from "@/components/BrandLogo";
import { EvidenceTrail } from "@/components/EvidenceTrail";
import { Skeleton } from "@/components/ui/skeleton";
import type { MarketEstimate } from "@/lib/market.functions";
import {
  computeAcquisitionCosts,
  computeMarketCeiling,
  DEFAULTS,
  MARKET_CEILING_SCENARIOS,
  type MarketCeilingResult,
} from "@/lib/profitability";
import type { AuctionSale, SaleDocumentRich, SaleMedia, SaleRiskOccurrence } from "@/lib/types";

// Anchors follow the reading order: what we know → bid ceiling → conditions →
// territory → documents.
const SECTION_NAV = [
  { id: "decision", label: "Décision" },
  { id: "assistant", label: "Plafond" },
  { id: "cout", label: "Coût complet" },
  { id: "hypotheses", label: "Hypothèses" },
  { id: "points", label: "Points à vérifier" },
  { id: "occupation", label: "Occupation" },
  { id: "travaux", label: "Travaux" },
  { id: "marche", label: "Marché" },
  { id: "documents", label: "Pièces" },
  { id: "checklist", label: "Checklist" },
  { id: "assistant-dossier", label: "Assistant" },
  { id: "notes", label: "Notes" },
  { id: "alertes", label: "Alertes" },
  { id: "comparaison", label: "Comparer" },
  { id: "similaires", label: "Similaires" },
  { id: "actions", label: "Actions" },
] as const;

/**
 * Presentational detail view. Split out from the route so it can be rendered
 * with any AuctionSale (route data, previews, tests). Organised around the maximum
 * bid the investor should not exceed, with sources and context below the decision.
 */
export function SaleDetailView({
  sale,
  marketEstimateOverride,
}: {
  sale: AuctionSale;
  marketEstimateOverride?: MarketEstimate | null;
}) {
  const location = saleLocation(sale.address, sale.postal_code, sale.city);
  const referenceLabel = sale.title ?? propertyTypeLabel(sale.property_type);
  const statusLabel = saleStatusLabel(sale.status);
  const surfaceInfo = getDisplaySurface(sale);
  const media = saleImages(sale.media);
  const decision = buildDecisionSummary(sale, marketEstimateOverride);
  const documentCount = countDocuments(sale);
  const acquisitionCost = computeAcquisitionCosts({
    price: decision.ceiling?.available
      ? decision.ceiling.maxBid
      : Math.max(0, sale.starting_price_eur ?? 0),
    works: DEFAULTS.works,
    fpt: DEFAULTS.fpt,
  });

  return (
    <main className="min-h-screen bg-white pb-28 text-foreground lg:pb-24">
      <section className="border-b border-border bg-white">
        <div className="mx-auto max-w-7xl px-4 pb-6 pt-5 sm:px-6 lg:px-8">
          <nav className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            <Link
              to="/sales"
              className="inline-flex items-center gap-1.5 transition-colors hover:text-gold-soft"
            >
              <ArrowLeft className="h-3 w-3" /> Annonces
            </Link>
            <ChevronRight className="h-3 w-3 opacity-40" />
            <span className="text-foreground/80">{sale.city ?? sale.department ?? "Détail"}</span>
          </nav>

          <div className="mt-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-4xl">
              <div className="flex flex-wrap items-center gap-3 text-[11px] uppercase tracking-[0.16em] text-gold-soft">
                <span>{propertyTypeLabel(sale.property_type)}</span>
                {sale.department && (
                  <span className="text-muted-foreground">· Département {sale.department}</span>
                )}
                {statusLabel && (
                  <span className="rounded-full border border-gold/30 bg-gold/10 px-2.5 py-1 text-[10px] tracking-[0.12em] text-gold-soft">
                    {statusLabel}
                  </span>
                )}
              </div>

              <h1 className="mt-3 font-sans text-3xl font-semibold leading-tight text-foreground sm:text-4xl lg:text-5xl">
                {referenceLabel}
              </h1>

              {location && (
                <p className="mt-3 inline-flex max-w-2xl items-center gap-2 text-sm text-muted-foreground sm:text-base">
                  <MapPin className="h-4 w-4 text-gold-soft" />
                  {location}
                </p>
              )}
            </div>

            <dl className="grid gap-3 rounded-lg border border-border bg-[#f7f7f7] p-3 sm:grid-cols-3 lg:min-w-[32rem]">
              <HeroMeta label="Mise à prix" value={formatPrice(sale.starting_price_eur)} accent />
              <HeroMeta label="Audience" value={formatDate(sale.sale_date)} />
              <HeroMeta
                label={surfaceInfo.metricLabel}
                value={surfaceInfo.value ? surfaceInfo.label : "—"}
              />
              <HeroMeta label="Occupation" value={occupancyLabel(sale.occupancy_status)} />
              <HeroMeta
                label="Pièces"
                value={`${documentCount} disponible${documentCount > 1 ? "s" : ""}`}
              />
              <HeroMeta label="Temps restant" value={timeRemainingLabel(sale.sale_date)} />
            </dl>
          </div>

          <div className="mt-5 grid gap-3 rounded-lg border border-border bg-surface/50 p-3 sm:grid-cols-2 lg:grid-cols-4">
            <QuickStat
              icon={<Target className="h-4 w-4" />}
              label="Plafond estimé"
              value={
                decision.ceiling?.available ? formatPrice(decision.ceiling.maxBid) : "À compléter"
              }
              detail={
                decision.ceiling?.available ? "Scénario équilibré" : "Marché local à renseigner"
              }
            />
            <QuickStat
              icon={<BadgeEuro className="h-4 w-4" />}
              label="Coût complet"
              value={formatPrice(acquisitionCost.totalCost)}
              detail="Avec frais estimés, hors travaux"
            />
            <QuickStat
              icon={<TriangleAlert className="h-4 w-4" />}
              label="Point principal"
              value={decision.primaryCheck}
              detail={decision.primaryDocument}
            />
            <QuickStat
              icon={<Scale className="h-4 w-4" />}
              label="Tribunal"
              value={sale.tribunal ?? sale.tribunal_name ?? "À confirmer"}
              detail={statusLabel ?? "Statut à vérifier"}
            />
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <FavoriteButton saleId={sale.id} className="justify-center px-4 py-2" />
            <HeaderAction href="#assistant" icon={<Target className="h-4 w-4" />}>
              Préparer mon enchère
            </HeaderAction>
            <HeaderAction onClick={printAnalysis} icon={<Download className="h-4 w-4" />}>
              Exporter l'analyse
            </HeaderAction>
            <HeaderAction
              onClick={() => void shareCurrentPage(referenceLabel)}
              icon={<Share2 className="h-4 w-4" />}
            >
              Partager le dossier
            </HeaderAction>
          </div>

          {media.length > 0 ? (
            <SaleMediaGallery media={media} />
          ) : (
            <div className="mt-5">
              <SaleLocationHero sale={sale} />
            </div>
          )}

          <nav
            aria-label="Sections du dossier"
            className="mt-4 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {SECTION_NAV.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="shrink-0 rounded-full border border-border bg-white px-3.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:border-gold/40 hover:text-gold-soft"
              >
                {s.label}
              </a>
            ))}
          </nav>
        </div>
      </section>

      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-x-12 gap-y-10 px-4 pt-10 sm:px-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:px-8">
        <div className="space-y-12">
          <Section id="decision" eyebrow="Décision rapide" title="Ce qui change la décision">
            <QuickDecision sale={sale} decision={decision} acquisitionCost={acquisitionCost} />
          </Section>

          {media.length > 0 && <SaleLocationHero sale={sale} />}

          <Section id="assistant" eyebrow="Mise plafond" title="Plafond d'enchère recommandé">
            <BidCeilingAssistant sale={sale} marketEstimateOverride={marketEstimateOverride} />
          </Section>

          <Section id="cout" eyebrow="Coût complet" title="Coût complet d'acquisition">
            <AcquisitionCostBlock
              sale={sale}
              cost={acquisitionCost}
              ceiling={decision.ceiling}
              marketEstimate={marketEstimateOverride}
            />
          </Section>

          <Section
            id="hypotheses"
            eyebrow="Simulation"
            title="Modifier travaux, frais et marge de sécurité"
          >
            <AdvancedAssumptionsBlock sale={sale} ceiling={decision.ceiling} />
          </Section>

          <Section id="points" eyebrow="Avant enchère" title="Points à vérifier avant enchère">
            <VerificationPoints sale={sale} />
          </Section>

          <Section id="occupation" eyebrow="Occupation" title="Situation d'occupation">
            <OccupationBlock sale={sale} ceiling={decision.ceiling} />
          </Section>

          <Section id="travaux" eyebrow="Travaux" title="Travaux à prévoir">
            <WorksBlock sale={sale} />
          </Section>

          <Section id="marche" eyebrow="Marché local" title="Marché local et comparables">
            <MarketLocalSection sale={sale} marketEstimate={marketEstimateOverride} />
          </Section>

          <Section id="bien" eyebrow="Synthèse du bien" title="Ce que nous savons du bien">
            <PropertyOverview sale={sale} />
          </Section>

          <FoldableSection
            id="preuves"
            eyebrow="Informations vérifiées"
            title="Ce que le dossier dit vraiment"
            summary="Voir les extraits utiles et les points à intégrer au prix plafond"
          >
            <EvidenceTrail sale={sale} />
          </FoldableSection>

          <Section
            id="documents"
            eyebrow="Pièces du dossier"
            title="Pièces à relire avant audience"
          >
            <DocumentsWorkspace sale={sale} />
          </Section>

          <Section id="checklist" eyebrow="Checklist" title="Checklist avant audience">
            <HearingChecklist sale={sale} />
          </Section>

          <Section id="questions" eyebrow="Préparation" title="Questions et calendrier">
            <PreparationGrid sale={sale} />
          </Section>

          <Section
            id="assistant-dossier"
            eyebrow="Assistant de dossier"
            title="Interroger le dossier"
          >
            <DossierAssistant sale={sale} cost={acquisitionCost} ceiling={decision.ceiling} />
          </Section>

          <Section
            id="notes"
            eyebrow="Notes et partage"
            title="Notes personnelles et partage privé"
          >
            <NotesAndSharingBlock sale={sale} />
          </Section>

          <Section id="alertes" eyebrow="Veille" title="Alertes liées à cette fiche">
            <SaleAlertsBlock sale={sale} />
          </Section>

          <Section id="comparaison" eyebrow="Comparer" title="Comparer cette vente">
            <ComparisonBlock sale={sale} ceiling={decision.ceiling} cost={acquisitionCost} />
          </Section>

          <Section id="similaires" eyebrow="Biens similaires" title="Biens et ventes comparables">
            <SimilarPropertiesBlock sale={sale} marketEstimate={marketEstimateOverride} />
          </Section>

          <Section id="actions" eyebrow="Actions finales" title="Actions finales avant audience">
            <FinalActionsBlock sale={sale} />
          </Section>

          <Section eyebrow="Référence" title="Informations techniques">
            <dl className="grid grid-cols-1 gap-x-8 gap-y-5 border-t border-border/60 pt-8 text-sm sm:grid-cols-2">
              <Meta
                label="Identifiant"
                value={<code className="break-all text-xs text-muted-foreground">{sale.id}</code>}
              />
              <Meta label="Source" value={sale.source_name ?? "—"} />
              {sale.tribunal_name && (
                <Meta
                  label="Tribunal"
                  value={`${sale.tribunal_name}${sale.tribunal_city ? ` — ${sale.tribunal_city}` : ""}`}
                />
              )}
              {sale.primary_source && (
                <Meta label="Source principale" value={sale.primary_source} />
              )}
              <Meta
                label="Latitude"
                value={sale.latitude != null ? sale.latitude.toFixed(6) : "—"}
              />
              <Meta
                label="Longitude"
                value={sale.longitude != null ? sale.longitude.toFixed(6) : "—"}
              />
              <Meta label="Ajoutée le" value={formatDateTime(sale.created_at)} />
              <Meta label="Mise à jour" value={formatDateTime(sale.updated_at)} />
            </dl>
            {sale.latitude != null && sale.longitude != null && (
              <a
                href={`https://www.google.com/maps?q=${sale.latitude},${sale.longitude}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-6 inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.25em] text-gold-soft hover:text-gold"
              >
                <MapPin className="h-3.5 w-3.5" /> Ouvrir sur Google Maps
              </a>
            )}
          </Section>
        </div>

        <aside className="hidden lg:sticky lg:top-24 lg:block lg:self-start">
          <DecisionRail sale={sale} decision={decision} acquisitionCost={acquisitionCost} />
        </aside>
      </div>
      <MobileActionBar sale={sale} decision={decision} />
    </main>
  );
}

function SaleMediaGallery({ media }: { media: SaleMedia[] }) {
  const featured = media[0];
  const thumbnails = media.slice(1, 5);
  const source = featured.source ?? media.find((item) => item.source)?.source;
  const thumbnailGrid =
    thumbnails.length === 1
      ? "grid-cols-1 md:grid-cols-1 md:grid-rows-1"
      : thumbnails.length === 2
        ? "grid-cols-2 md:grid-cols-1 md:grid-rows-2"
        : `grid-cols-2 md:grid-rows-2 ${
            thumbnails.length === 3 ? "[&>a:last-child]:col-span-2" : ""
          }`;

  return (
    <section className="relative mt-5 overflow-hidden rounded-lg border border-border bg-muted">
      <div className="absolute left-3 top-3 z-10 rounded-full border border-white/60 bg-white/90 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-foreground backdrop-blur">
        Photos du bien
      </div>
      {source && (
        <span className="absolute bottom-3 right-3 z-10 rounded-full border border-white/60 bg-white/90 px-3 py-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground backdrop-blur">
          Source · {source}
        </span>
      )}
      <div
        className={
          thumbnails.length > 0
            ? "grid gap-1 bg-white md:grid-cols-[minmax(0,2fr)_minmax(220px,1fr)]"
            : "bg-white"
        }
      >
        <SaleMediaImage media={featured} featured />
        {thumbnails.length > 0 && (
          <div
            className={`grid gap-1 md:h-full [&>a]:md:aspect-auto [&>a]:md:h-full ${thumbnailGrid}`}
          >
            {thumbnails.map((item) => (
              <SaleMediaImage key={item.url} media={item} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function SaleMediaImage({ media, featured = false }: { media: SaleMedia; featured?: boolean }) {
  return (
    <a
      href={media.url}
      target="_blank"
      rel="noopener noreferrer"
      className={
        featured
          ? "group relative block aspect-[4/3] cursor-pointer overflow-hidden bg-muted md:aspect-[16/10]"
          : "group relative block aspect-[4/3] cursor-pointer overflow-hidden bg-muted"
      }
    >
      <img
        src={media.url}
        alt="Photo du bien"
        loading={featured ? "eager" : "lazy"}
        decoding="async"
        referrerPolicy="no-referrer"
        className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]"
      />
      <span className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/45 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-white opacity-0 backdrop-blur transition-opacity group-hover:opacity-100">
        Ouvrir <ExternalLink className="h-3 w-3" />
      </span>
    </a>
  );
}

function saleImages(media: AuctionSale["media"] | undefined): SaleMedia[] {
  if (!Array.isArray(media)) return [];
  const seen = new Set<string>();
  return media.filter((item): item is SaleMedia => {
    const url = typeof item?.url === "string" ? item.url.trim() : "";
    if (!url || seen.has(url) || !/^https?:\/\//i.test(url)) return false;
    seen.add(url);
    return true;
  });
}

type DecisionSummary = {
  ceiling: MarketCeilingResult;
  primaryCheck: string;
  primaryDocument: string;
  action: string;
  dossierStatus: string;
};

type AcquisitionCost = ReturnType<typeof computeAcquisitionCosts>;

function QuickStat({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-md border border-border bg-white p-3">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        <span className="text-gold-soft">{icon}</span>
        {label}
      </div>
      <div className="mt-2 truncate text-sm font-semibold tabular-nums text-foreground">
        {value}
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

function HeaderAction({
  href,
  onClick,
  icon,
  children,
}: {
  href?: string;
  onClick?: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const className =
    "inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.1em] text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft";

  if (href) {
    return (
      <a href={href} className={className}>
        {icon}
        {children}
      </a>
    );
  }

  return (
    <button type="button" onClick={onClick} className={className}>
      {icon}
      {children}
    </button>
  );
}

function QuickDecision({
  sale,
  decision,
  acquisitionCost,
}: {
  sale: AuctionSale;
  decision: DecisionSummary;
  acquisitionCost: AcquisitionCost;
}) {
  const documentCount = countDocuments(sale);
  const ceilingAvailable = decision.ceiling.available;
  const rows = [
    {
      label: "Plafond conseillé",
      value: ceilingAvailable ? formatPrice(decision.ceiling.maxBid) : "À compléter",
      detail: ceilingAvailable
        ? "Ce montant vient du scénario équilibré."
        : "Ajoutez le marché local dans l'assistant pour sortir un plafond.",
    },
    {
      label: "Point principal à vérifier",
      value: decision.primaryCheck,
      detail: "Ce point peut modifier le plafond avant audience.",
    },
    {
      label: "Document prioritaire",
      value: decision.primaryDocument,
      detail: "À relire ou faire confirmer si l'information reste floue.",
    },
    {
      label: "Coût complet simulé",
      value: formatPrice(acquisitionCost.totalCost),
      detail: "Enchère simulée, droits, émoluments et FPT.",
    },
    {
      label: "Action recommandée",
      value: decision.action,
      detail: "À traiter avant de transmettre vos consignes.",
    },
    {
      label: "Statut du dossier",
      value: decision.dossierStatus,
      detail: `${documentCount} pièce${documentCount > 1 ? "s" : ""} disponible${documentCount > 1 ? "s" : ""}.`,
    },
  ];

  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm sm:p-6">
      <div className="grid gap-3 md:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="rounded-lg border border-border bg-muted/30 p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gold-soft">
              {row.label}
            </div>
            <div className="mt-2 text-base font-semibold text-foreground">{row.value}</div>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{row.detail}</p>
          </div>
        ))}
      </div>
      <p className="mt-4 rounded-lg border border-gold/20 bg-gold/[0.06] px-4 py-3 text-sm leading-relaxed text-muted-foreground">
        Ce bloc ne donne pas de note. Il isole ce qui est connu, ce qui reste à confirmer et ce qui
        peut faire bouger votre plafond d'enchère.
      </p>
    </div>
  );
}

function AcquisitionCostBlock({
  sale,
  cost,
  ceiling,
  marketEstimate,
}: {
  sale: AuctionSale;
  cost: AcquisitionCost;
  ceiling: MarketCeilingResult;
  marketEstimate?: MarketEstimate | null;
}) {
  const surface = getSaleSurface(sale).value;
  const costPerM2 = surface ? cost.totalCost / surface : null;
  const marketGap =
    costPerM2 != null && marketEstimate?.medianPricePerM2
      ? marketEstimate.medianPricePerM2 - costPerM2
      : null;
  const safetyBudget = ceiling.available
    ? Math.max(0, ceiling.targetTotalCost - cost.totalCost)
    : 0;

  return (
    <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
      <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
        <dl className="grid gap-3 text-sm">
          <CostRow label="Prix d'enchère simulé" value={formatPrice(cost.price)} strong />
          <CostRow label="Frais de procédure estimés" value={formatPrice(cost.fpt)} />
          <CostRow label="Émoluments avocat TTC" value={formatPrice(cost.emolumentsTTC)} />
          <CostRow label="Droits et taxes" value={formatPrice(cost.registrationDuties)} />
          <CostRow label="Travaux estimés" value={formatPrice(cost.works)} />
          <CostRow label="Budget de sécurité restant" value={formatPrice(safetyBudget)} />
          <CostRow label="Coût total estimé" value={formatPrice(cost.totalCost)} strong />
        </dl>
      </div>
      <div className="rounded-lg border border-border bg-muted/35 p-5">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft">
          Lecture financière
        </div>
        <dl className="mt-4 grid gap-3 text-sm">
          <CostRow label="Coût complet au m²" value={formatPricePerM2(costPerM2)} />
          <CostRow
            label="Prix/m² du secteur"
            value={formatPricePerM2(marketEstimate?.medianPricePerM2)}
          />
          <CostRow
            label="Écart estimé avec le marché"
            value={marketGap == null ? "À compléter" : formatPricePerM2(marketGap)}
          />
          <CostRow
            label="Seuil à ne pas dépasser"
            value={ceiling.available ? formatPrice(ceiling.maxBid) : "À compléter"}
          />
        </dl>
        <a
          href="#assistant"
          className="mt-5 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft transition-colors hover:text-gold"
        >
          Modifier travaux, frais et marge de sécurité <ChevronRight className="h-3.5 w-3.5" />
        </a>
      </div>
    </div>
  );
}

function VerificationPoints({ sale }: { sale: AuctionSale }) {
  const points = buildVerificationPoints(sale);
  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <ul className="divide-y divide-border/60">
        {points.map((point) => (
          <li key={point.label} className="grid gap-3 py-4 sm:grid-cols-[1fr_auto] sm:items-start">
            <div>
              <div className="font-medium text-foreground">{point.label}</div>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{point.detail}</p>
            </div>
            <StatusBadge status={point.status} tone={point.tone} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function DocumentsWorkspace({ sale }: { sale: AuctionSale }) {
  const richDocs = sale.documents_rich ?? [];
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [state, setState] = useLocalState<{
    notes: Record<string, string>;
    readPages: Record<string, boolean>;
    highlighted: string | null;
  }>(saleStorageKey(sale.id, "documents-workspace"), {
    notes: {},
    readPages: {},
    highlighted: null,
  });

  if (richDocs.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
        <DocumentsList documents={sale.documents} />
      </div>
    );
  }

  const selected = richDocs[Math.min(selectedIndex, richDocs.length - 1)];
  const selectedKey = documentKey(selected);
  const selectedOccurrences = documentOccurrences(sale, selected);

  return (
    <div className="space-y-4">
      <div className="grid gap-3">
        {richDocs.map((document, index) => {
          const pages = documentPagesToReview(sale, document);
          const key = documentKey(document);
          const readCount = Object.keys(state.readPages).filter((pageKey) =>
            pageKey.startsWith(`${key}:`),
          ).length;
          return (
            <article
              key={`${document.url}-${index}`}
              className={`rounded-lg border bg-white p-5 shadow-sm ${
                index === selectedIndex ? "border-gold/40" : "border-border"
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft">
                    <FileCheck2 className="h-4 w-4" />
                    {documentTypeLabel(document.document_type ?? document.type)}
                  </div>
                  <h3 className="mt-2 truncate text-base font-semibold text-foreground">
                    {document.label ?? document.url.split("/").pop() ?? `Pièce ${index + 1}`}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Disponible ·{" "}
                    {document.text_chars
                      ? `${document.text_chars.toLocaleString("fr-FR")} caractères lus`
                      : "lecture à confirmer"}
                    {readCount
                      ? ` · ${readCount} page${readCount > 1 ? "s" : ""} relue${readCount > 1 ? "s" : ""}`
                      : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedIndex(index)}
                    className="inline-flex items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.1em] text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft"
                  >
                    Ouvrir lecteur
                  </button>
                  <a
                    href={document.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.1em] text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft"
                  >
                    Ouvrir <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-[1fr_220px]">
                <div className="rounded-md border border-border bg-muted/30 p-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    À relire
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-foreground">
                    {documentReviewPrompt(document)}
                  </p>
                  {pages && (
                    <p className="mt-2 text-xs text-muted-foreground">Pages signalées : {pages}</p>
                  )}
                </div>
                <label className="block rounded-md border border-border bg-white p-3">
                  <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    Note personnelle
                  </span>
                  <textarea
                    rows={3}
                    value={state.notes[key] ?? ""}
                    onChange={(event) =>
                      setState((current) => ({
                        ...current,
                        notes: { ...current.notes, [key]: event.target.value },
                      }))
                    }
                    className="mt-2 w-full resize-none rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                    placeholder="Point à demander à l'avocat..."
                  />
                </label>
              </div>
            </article>
          );
        })}
      </div>

      <div className="grid gap-4 rounded-lg border border-border bg-white p-5 shadow-sm lg:grid-cols-[minmax(0,1.1fr)_minmax(280px,0.9fr)]">
        <div className="min-h-[420px] overflow-hidden rounded-lg border border-border bg-muted/30">
          <iframe
            title={`Lecteur ${selected.label ?? "document"}`}
            src={selected.url}
            className="h-[420px] w-full bg-white"
          />
        </div>
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft">
            Lecteur de pièces
          </div>
          <h3 className="mt-2 text-lg font-semibold text-foreground">
            {selected.label ?? selected.url.split("/").pop() ?? "Pièce du dossier"}
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Passages importants, notes personnelles et pages relues restent reliés à cette pièce.
          </p>
          <div className="mt-4 space-y-3">
            {selectedOccurrences.length ? (
              selectedOccurrences.map((occurrence, index) => {
                const page = occurrence.page_number ?? index + 1;
                const pageKey = `${selectedKey}:${page}`;
                return (
                  <div
                    key={`${pageKey}-${index}`}
                    className={`rounded-md border p-3 ${
                      state.highlighted === occurrence.excerpt
                        ? "border-gold/50 bg-gold/[0.08]"
                        : "border-border bg-muted/30"
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                        Page {page}
                      </span>
                      <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={Boolean(state.readPages[pageKey])}
                          onChange={(event) =>
                            setState((current) => ({
                              ...current,
                              readPages: {
                                ...current.readPages,
                                [pageKey]: event.target.checked,
                              },
                            }))
                          }
                          className="h-4 w-4 accent-[var(--gold)]"
                        />
                        Page relue
                      </label>
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-foreground">
                      {occurrence.excerpt ?? "Extrait à relire dans la pièce."}
                    </p>
                    <button
                      type="button"
                      onClick={() =>
                        setState((current) => ({
                          ...current,
                          highlighted:
                            current.highlighted === occurrence.excerpt ? null : occurrence.excerpt,
                        }))
                      }
                      className="mt-3 text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft hover:text-gold"
                    >
                      Surligner l'élément sensible
                    </button>
                  </div>
                );
              })
            ) : (
              <p className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                Aucun extrait sensible n'est associé automatiquement à cette pièce. Relire et
                ajouter une note si nécessaire.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function HearingChecklist({ sale }: { sale: AuctionSale }) {
  const hasDocuments = countDocuments(sale) > 0;
  const unknownOccupation = isUnknownOccupation(sale.occupancy_status);
  const [statuses, setStatuses] = useLocalState<Record<string, string>>(
    saleStorageKey(sale.id, "hearing-checklist"),
    {},
  );
  const items = [
    ["Mandater un avocat", "À faire"],
    ["Valider le financement", "À faire"],
    ["Préparer la consignation", "À faire"],
    [
      "Relire le cahier des conditions de vente",
      hasDocumentType(sale, /cahier|conditions/) ? "En cours" : "À faire",
    ],
    [
      "Relire le PV descriptif",
      hasDocumentType(sale, /pv|descriptif|huissier/) ? "En cours" : "À faire",
    ],
    ["Vérifier l'occupation", unknownOccupation ? "À faire confirmer" : "En cours"],
    ["Estimer les travaux", hasWorksRisk(sale) ? "À faire" : "En cours"],
    ["Définir son plafond d'enchère", "En cours"],
    ["Transmettre les consignes à l'avocat", "À faire"],
    ["Prévoir les frais annexes", "En cours"],
    ["Vérifier le délai de surenchère", hasDocuments ? "À faire relire" : "À faire"],
    ["Préparer le scénario post-adjudication", "À faire"],
  ] as const;

  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <ul className="grid gap-3 md:grid-cols-2">
        {items.map(([label, status]) => (
          <li
            key={label}
            className="grid gap-3 rounded-md border border-border bg-muted/30 p-3 sm:grid-cols-[1fr_auto] sm:items-center"
          >
            <div className="flex items-start gap-3">
              <ClipboardCheck className="mt-0.5 h-4 w-4 shrink-0 text-gold-soft" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">{label}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Statut recommandé : {status}
                </div>
              </div>
            </div>
            <label className="block">
              <span className="sr-only">Statut de {label}</span>
              <select
                value={statuses[label] ?? status}
                onChange={(event) =>
                  setStatuses((current) => ({ ...current, [label]: event.target.value }))
                }
                className="w-full rounded-md border border-border bg-white px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring sm:w-36"
              >
                {["À faire", "En cours", "À faire confirmer", "À faire relire", "Terminé"].map(
                  (item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ),
                )}
              </select>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PreparationGrid({ sale }: { sale: AuctionSale }) {
  const questions = [
    "L'occupation du bien est-elle confirmée dans le PV descriptif ?",
    "Le cahier des conditions contient-il des clauses ou frais particuliers ?",
    "Quel budget travaux faut-il provisionner avant l'audience ?",
    "Le financement couvre-t-il le prix, les frais et les délais ?",
    "À quel montant l'opération ne m'intéresse plus ?",
  ];
  const timeline = [
    ["Relire les pièces", "Avant de fixer le plafond"],
    ["Mandater l'avocat", "Avant toute enchère"],
    ["Préparer la consignation", "Avant l'audience"],
    ["Audience d'adjudication", formatDate(sale.sale_date)],
    ["Délai de surenchère", "Après adjudication"],
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft">
          <CircleHelp className="h-4 w-4" />
          Questions à poser
        </div>
        <ul className="mt-4 space-y-3 text-sm leading-relaxed text-muted-foreground">
          {questions.map((question) => (
            <li key={question} className="flex gap-2">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-gold" />
              <span>{question}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft">
          <CalendarDays className="h-4 w-4" />
          Calendrier de procédure
        </div>
        <ol className="mt-4 space-y-3">
          {timeline.map(([label, date]) => (
            <li key={label} className="flex items-start gap-3 text-sm">
              <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-gold-soft" />
              <span className="min-w-0">
                <span className="block font-medium text-foreground">{label}</span>
                <span className="block text-muted-foreground">{date}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function CostRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${strong ? "font-semibold" : ""}`}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

function StatusBadge({
  status,
  tone,
}: {
  status: string;
  tone: "verified" | "watch" | "missing" | "risk";
}) {
  const className =
    tone === "verified"
      ? "chip chip-verified"
      : tone === "risk"
        ? "chip chip-risk"
        : tone === "missing"
          ? "chip chip-neutral"
          : "chip chip-watch";
  return (
    <span className={`${className} justify-self-start sm:justify-self-end`}>
      <span aria-hidden className="chip-dot" />
      {status}
    </span>
  );
}

type AdvancedAssumptions = {
  works: number;
  lawyerFees: number;
  adjudicationFees: number;
  publicationFees: number;
  otherFees: number;
  safetyMarginPct: number;
  resalePrice: number;
  monthlyRent: number;
  holdingMonths: number;
  totalBudget: number;
};

type StoredNotes = {
  general: string;
  occupation: string;
  works: string;
  market: string;
  privateMode: boolean;
};

type LocalStateSetter<T> = (next: T | ((current: T) => T)) => void;

function useLocalState<T>(key: string, initialValue: T): [T, LocalStateSetter<T>] {
  const initialSerialized = JSON.stringify(initialValue);
  const [value, setValue] = useState<T>(initialValue);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  useEffect(() => {
    const fallback = JSON.parse(initialSerialized) as T;
    setValue(readLocalState(key, fallback));
    setLoadedKey(key);
  }, [key, initialSerialized]);

  useEffect(() => {
    if (loadedKey !== key || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Local storage can be unavailable in private browsing; the UI remains usable.
    }
  }, [key, loadedKey, value]);

  const update: LocalStateSetter<T> = (next) => {
    setValue((current) =>
      typeof next === "function" ? (next as (current: T) => T)(current) : next,
    );
  };

  return [value, update];
}

function readLocalState<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(fallback) && isRecord(parsed)) return { ...fallback, ...parsed } as T;
    return parsed as T;
  } catch {
    return fallback;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function saleStorageKey(saleId: string, scope: string): string {
  return `immojudis:sale:${saleId}:${scope}`;
}

function signedAmount(value: number): string {
  const rounded = Math.round(value);
  return `${rounded >= 0 ? "+" : "-"}${formatPrice(Math.abs(rounded))}`;
}

function riskOccurrences(sale: AuctionSale): SaleRiskOccurrence[] {
  return (sale.risks ?? []).flatMap((risk) => risk.occurrences ?? []);
}

function documentKey(document: SaleDocumentRich): string {
  return [document.document_type ?? document.type, document.label, document.url]
    .filter(Boolean)
    .join(":");
}

function documentOccurrences(sale: AuctionSale, document: SaleDocumentRich): SaleRiskOccurrence[] {
  const documentType = document.document_type ?? document.type;
  return riskOccurrences(sale).filter((occurrence) => {
    const sameType = documentType && occurrence.document_type === documentType;
    const sameLabel = document.label && occurrence.document_label === document.label;
    const sameUrl = document.url && occurrence.document_url === document.url;
    return Boolean(sameType || sameLabel || sameUrl);
  });
}

function ScenarioCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-md border border-border bg-white p-3">
      <div className="text-sm font-semibold text-foreground">{title}</div>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{text}</p>
    </div>
  );
}

function AdvancedAssumptionsBlock({
  sale,
  ceiling,
}: {
  sale: AuctionSale;
  ceiling: MarketCeilingResult;
}) {
  const [assumptions, setAssumptions] = useLocalState<AdvancedAssumptions>(
    saleStorageKey(sale.id, "advanced-assumptions"),
    {
      works: DEFAULTS.works,
      lawyerFees: 0,
      adjudicationFees: 0,
      publicationFees: 0,
      otherFees: 0,
      safetyMarginPct: DEFAULTS.safetyDiscountPct,
      resalePrice: 0,
      monthlyRent: 0,
      holdingMonths: 0,
      totalBudget: 0,
    },
  );
  const extraFees =
    assumptions.lawyerFees +
    assumptions.adjudicationFees +
    assumptions.publicationFees +
    assumptions.otherFees;
  const simulatedCost = computeAcquisitionCosts({
    price: ceiling.available ? ceiling.maxBid : Math.max(0, sale.starting_price_eur ?? 0),
    works: assumptions.works,
    fpt: DEFAULTS.fpt + extraFees,
  });
  const resaleMargin = assumptions.resalePrice
    ? assumptions.resalePrice - simulatedCost.totalCost
    : null;
  const rentalIncome =
    assumptions.monthlyRent > 0 && assumptions.holdingMonths > 0
      ? assumptions.monthlyRent * assumptions.holdingMonths
      : null;
  const budgetDelta = assumptions.totalBudget
    ? assumptions.totalBudget - simulatedCost.totalCost
    : null;

  const update = (key: keyof AdvancedAssumptions, value: number) =>
    setAssumptions((current) => ({ ...current, [key]: Math.max(0, value || 0) }));

  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        <MoneyField
          label="Budget travaux"
          value={assumptions.works}
          onChange={(v) => update("works", v)}
        />
        <MoneyField
          label="Frais d'avocat"
          value={assumptions.lawyerFees}
          onChange={(v) => update("lawyerFees", v)}
        />
        <MoneyField
          label="Frais d'adjudication"
          value={assumptions.adjudicationFees}
          onChange={(v) => update("adjudicationFees", v)}
        />
        <MoneyField
          label="Frais de publication"
          value={assumptions.publicationFees}
          onChange={(v) => update("publicationFees", v)}
        />
        <MoneyField
          label="Frais divers"
          value={assumptions.otherFees}
          onChange={(v) => update("otherFees", v)}
        />
        <MoneyField
          label="Prix de revente estimé"
          value={assumptions.resalePrice}
          onChange={(v) => update("resalePrice", v)}
        />
        <MoneyField
          label="Loyer potentiel mensuel"
          value={assumptions.monthlyRent}
          onChange={(v) => update("monthlyRent", v)}
        />
        <MoneyField
          label="Durée avant revente/location"
          suffix="mois"
          value={assumptions.holdingMonths}
          onChange={(v) => update("holdingMonths", v)}
        />
        <MoneyField
          label="Budget total disponible"
          value={assumptions.totalBudget}
          onChange={(v) => update("totalBudget", v)}
        />
      </div>
      <label className="mt-4 block">
        <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Marge de sécurité souhaitée : {assumptions.safetyMarginPct}%
        </span>
        <input
          type="range"
          min={0}
          max={40}
          value={assumptions.safetyMarginPct}
          onChange={(event) => update("safetyMarginPct", Number(event.target.value))}
          className="mt-2 w-full accent-[var(--gold)]"
        />
      </label>
      <dl className="mt-5 grid gap-3 rounded-lg border border-border bg-muted/30 p-4 text-sm md:grid-cols-3">
        <CostRow label="Coût complet ajusté" value={formatPrice(simulatedCost.totalCost)} strong />
        <CostRow
          label="Marge à la revente"
          value={resaleMargin == null ? "À compléter" : signedAmount(resaleMargin)}
        />
        <CostRow
          label="Revenu locatif période"
          value={rentalIncome == null ? "À compléter" : formatPrice(rentalIncome)}
        />
        <CostRow
          label="Budget restant"
          value={budgetDelta == null ? "À compléter" : signedAmount(budgetDelta)}
        />
        <CostRow label="Frais personnalisés" value={formatPrice(extraFees)} />
        <CostRow
          label="Plafond actuel"
          value={ceiling.available ? formatPrice(ceiling.maxBid) : "À compléter"}
        />
      </dl>
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        Ce plafond dépend des hypothèses de travaux, frais, occupation, documents et marché. Il doit
        être validé avec les professionnels compétents avant toute enchère.
      </p>
    </div>
  );
}

function MoneyField({
  label,
  value,
  onChange,
  suffix = "€",
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  suffix?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="mt-1 flex items-center rounded-md border border-border bg-white focus-within:ring-1 focus-within:ring-ring">
        <input
          type="number"
          min={0}
          inputMode="decimal"
          value={value || ""}
          onChange={(event) => onChange(Number(event.target.value))}
          className="w-full bg-transparent px-3 py-2 text-sm tabular-nums outline-none"
        />
        <span className="pr-3 text-xs text-muted-foreground">{suffix}</span>
      </div>
    </label>
  );
}

function OccupationBlock({ sale, ceiling }: { sale: AuctionSale; ceiling: MarketCeilingResult }) {
  const occurrence = riskOccurrences(sale).find((item) =>
    `${item.document_type ?? ""} ${item.excerpt ?? ""}`.toLowerCase().includes("occupation"),
  );
  const unknown = isUnknownOccupation(sale.occupancy_status);
  const adjusted = ceiling.available ? Math.max(0, ceiling.maxBid - 8_000) : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
      <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
        <dl className="grid gap-3 text-sm">
          <CostRow label="Statut actuel" value={occupancyLabel(sale.occupancy_status)} strong />
          <CostRow label="Source consultée" value={primaryDocumentLabel(sale, "occupation")} />
          <CostRow
            label="Information disponible"
            value={unknown ? "Non précisée ou partielle" : "À vérifier dans les pièces"}
          />
          <CostRow
            label="Impact plafond"
            value={adjusted == null ? "À compléter" : `Prudence : ${formatPrice(adjusted)}`}
          />
        </dl>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          Impact potentiel : délai de libération, travaux différés, absence de jouissance immédiate
          et coût de sortie. Faire confirmer la situation avant audience.
        </p>
      </div>
      <div className="rounded-lg border border-border bg-muted/30 p-5">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft">
          Extrait et scénarios
        </div>
        <blockquote className="mt-3 rounded-md border border-border bg-white p-3 text-sm leading-relaxed text-foreground">
          {occurrence?.excerpt ??
            "Aucun extrait d'occupation n'est relié à ce dossier. Relire le PV descriptif avant décision."}
        </blockquote>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <ScenarioCard
            title="Si le bien est libre"
            text="Hypothèse favorable : prise de possession plus simple, travaux et revente/location plus prévisibles."
          />
          <ScenarioCard
            title="Si le bien est occupé"
            text="Prévoir délai, coût de sortie et impossibilité de travaux immédiats dans le plafond."
          />
        </div>
      </div>
    </div>
  );
}

function WorksBlock({ sale }: { sale: AuctionSale }) {
  const [budgets, setBudgets] = useLocalState<Record<string, number>>(
    saleStorageKey(sale.id, "works-budgets"),
    {},
  );
  const categories = [
    "Peinture",
    "Sols",
    "Électricité",
    "Plomberie",
    "Cuisine",
    "Salle de bain",
    "Menuiseries",
    "Chauffage",
    "Copropriété",
    "Parties communes",
  ];
  const total = categories.reduce((sum, category) => sum + (budgets[category] || 0), 0);
  const high = Math.round(total * 1.25);
  const low = Math.round(total * 0.85);
  const worksRisks = (sale.risks ?? []).filter((risk) =>
    `${risk.risk_label ?? ""} ${risk.risk_type ?? ""}`
      .toLowerCase()
      .match(/travaux|renov|etat|état/),
  );

  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <div className="grid gap-3 md:grid-cols-3">
        <QuickStat
          icon={<TriangleAlert className="h-4 w-4" />}
          label="Hypothèse basse"
          value={formatPrice(low)}
          detail="À confirmer devis"
        />
        <QuickStat
          icon={<BadgeEuro className="h-4 w-4" />}
          label="Hypothèse médiane"
          value={formatPrice(total)}
          detail="Budget saisi"
        />
        <QuickStat
          icon={<TriangleAlert className="h-4 w-4" />}
          label="Hypothèse haute"
          value={formatPrice(high)}
          detail="Marge travaux +25%"
        />
      </div>
      <div className="mt-5 grid gap-3 md:grid-cols-2">
        {categories.map((category) => (
          <MoneyField
            key={category}
            label={category}
            value={budgets[category] || 0}
            onChange={(value) => setBudgets((current) => ({ ...current, [category]: value }))}
          />
        ))}
      </div>
      <div className="mt-5 rounded-lg border border-border bg-muted/30 p-4">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Éléments détectés
        </div>
        {worksRisks.length ? (
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            {worksRisks.map((risk) => (
              <li key={risk.risk_type}>
                {risk.risk_label || risk.risk_type} : {risk.evidence ?? "à relire dans les pièces"}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            Aucun poste travaux fiable n'est encore détecté. Ajouter des devis ou une estimation
            artisan avant l'audience.
          </p>
        )}
      </div>
    </div>
  );
}

function MarketLocalSection({
  sale,
  marketEstimate,
}: {
  sale: AuctionSale;
  marketEstimate?: MarketEstimate | null;
}) {
  const [filters, setFilters] = useLocalState(saleStorageKey(sale.id, "market-filters"), {
    distance: "rayon actuel",
    period: "6 ans",
    surface: "surface proche",
  });
  const transactions = marketEstimate?.recentTransactions ?? [];
  const excluded = marketEstimate
    ? Math.max(0, marketEstimate.totalNearbySampleSize - marketEstimate.sampleSize)
    : 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        <QuickStat
          icon={<MapPin className="h-4 w-4" />}
          label="Prix médian"
          value={formatPricePerM2(marketEstimate?.medianPricePerM2)}
          detail={marketEstimate?.commune ?? sale.city ?? "Secteur"}
        />
        <QuickStat
          icon={<Scale className="h-4 w-4" />}
          label="Fourchette basse"
          value={formatPricePerM2(marketEstimate?.p25PricePerM2)}
          detail="Quartile bas"
        />
        <QuickStat
          icon={<Scale className="h-4 w-4" />}
          label="Fourchette haute"
          value={formatPricePerM2(marketEstimate?.p75PricePerM2)}
          detail="Quartile haut"
        />
        <QuickStat
          icon={<FileCheck2 className="h-4 w-4" />}
          label="Comparables retenus"
          value={marketEstimate ? String(marketEstimate.sampleSize) : "À compléter"}
          detail={`${excluded} exclu${excluded > 1 ? "s" : ""}`}
        />
      </div>
      <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
        <div className="grid gap-3 md:grid-cols-3">
          <FilterSelect
            label="Distance"
            value={filters.distance}
            values={["rayon actuel", "100 m", "300 m", "1 km"]}
            onChange={(distance) => setFilters((current) => ({ ...current, distance }))}
          />
          <FilterSelect
            label="Période"
            value={filters.period}
            values={["6 ans", "3 ans", "12 mois"]}
            onChange={(period) => setFilters((current) => ({ ...current, period }))}
          />
          <FilterSelect
            label="Surface"
            value={filters.surface}
            values={[
              "surface proche",
              "toutes surfaces",
              "surface inférieure",
              "surface supérieure",
            ]}
            onChange={(surface) => setFilters((current) => ({ ...current, surface }))}
          />
        </div>
        <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_1.2fr]">
          <div className="rounded-lg border border-border bg-muted/30 p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Carte des comparables
            </div>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              {sale.latitude != null && sale.longitude != null
                ? "Ouvrir la carte pour inspecter le secteur autour de l'adresse."
                : "Coordonnées manquantes : carte indisponible pour ce dossier."}
            </p>
            {sale.latitude != null && sale.longitude != null && (
              <a
                href={`https://www.google.com/maps?q=${sale.latitude},${sale.longitude}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft hover:text-gold"
              >
                Ouvrir la carte <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/50 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Surface</th>
                  <th className="px-3 py-2">Prix</th>
                  <th className="px-3 py-2">Prix/m²</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {transactions.length ? (
                  transactions.slice(0, 6).map((transaction, index) => (
                    <tr key={`${transaction.date}-${index}`}>
                      <td className="px-3 py-2 text-muted-foreground">
                        {formatDate(transaction.date)}
                      </td>
                      <td className="px-3 py-2">
                        {transaction.surface ? `${Math.round(transaction.surface)} m²` : "—"}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {formatPrice(transaction.totalPrice)}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {formatPricePerM2(transaction.pricePerM2)}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="px-3 py-4 text-sm text-muted-foreground">
                      Les comparables détaillés apparaîtront quand l'estimation DVF sera disponible.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          Méthode : conserver les ventes proches du bien, exclure les surfaces trop différentes et
          les caractéristiques atypiques, puis comparer le coût complet au prix de marché local.
        </p>
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value: string;
  values: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
      >
        {values.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
    </label>
  );
}

function DossierAssistant({
  sale,
  cost,
  ceiling,
}: {
  sale: AuctionSale;
  cost: AcquisitionCost;
  ceiling: MarketCeilingResult;
}) {
  const questions = [
    "Le bien est-il occupé ?",
    "Quels documents relire en priorité ?",
    "Quels frais prévoir ?",
    "Quels éléments peuvent modifier mon plafond ?",
    "Quels points demander à l'avocat ?",
    "Quels travaux sont mentionnés ?",
    "Quel est le coût complet estimé ?",
    "À quel prix l'opération devient moins intéressante ?",
  ];
  const [question, setQuestion] = useState(questions[0]);
  const answer = answerDossierQuestion(question, sale, cost, ceiling);

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <div className="rounded-lg border border-border bg-white p-4 shadow-sm">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft">
          Questions rapides
        </div>
        <div className="mt-3 grid gap-2">
          {questions.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setQuestion(item)}
              className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                item === question
                  ? "border-gold/50 bg-gold/[0.08] text-foreground"
                  : "border-border bg-white text-muted-foreground hover:border-gold/40 hover:text-foreground"
              }`}
            >
              {item}
            </button>
          ))}
        </div>
      </div>
      <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft">
          Réponse sourcée
        </div>
        <h3 className="mt-2 text-lg font-semibold text-foreground">{question}</h3>
        <p className="mt-3 text-sm leading-relaxed text-foreground">{answer.text}</p>
        <div className="mt-4 rounded-md border border-border bg-muted/30 p-3 text-sm">
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Source
          </div>
          <p className="mt-2 text-muted-foreground">{answer.source}</p>
          {answer.excerpt && (
            <blockquote className="mt-2 text-foreground">{answer.excerpt}</blockquote>
          )}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          L'assistant aide à lire le dossier ; il ne remplace pas la validation par l'avocat, le
          courtier ou l'artisan.
        </p>
      </div>
    </div>
  );
}

function NotesAndSharingBlock({ sale }: { sale: AuctionSale }) {
  const [notes, setNotes] = useLocalState<StoredNotes>(saleStorageKey(sale.id, "notes"), {
    general: "",
    occupation: "",
    works: "",
    market: "",
    privateMode: true,
  });
  const inviteText = `Peux-tu vérifier ce dossier Immojudis ? ${sale.title ?? "Vente judiciaire"} - ${typeof window !== "undefined" ? window.location.href : ""}`;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_0.9fr]">
      <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft">
            Notes personnelles
          </div>
          <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={notes.privateMode}
              onChange={(event) =>
                setNotes((current) => ({ ...current, privateMode: event.target.checked }))
              }
              className="h-4 w-4 accent-[var(--gold)]"
            />
            Notes privées
          </label>
        </div>
        <div className="mt-4 grid gap-3">
          <NoteField
            label="Note générale"
            value={notes.general}
            onChange={(general) => setNotes((current) => ({ ...current, general }))}
          />
          <NoteField
            label="Occupation"
            value={notes.occupation}
            onChange={(occupation) => setNotes((current) => ({ ...current, occupation }))}
          />
          <NoteField
            label="Travaux"
            value={notes.works}
            onChange={(works) => setNotes((current) => ({ ...current, works }))}
          />
          <NoteField
            label="Marché local"
            value={notes.market}
            onChange={(market) => setNotes((current) => ({ ...current, market }))}
          />
        </div>
        <button
          type="button"
          onClick={() => downloadText(`notes-${sale.id}.txt`, notesToText(sale, notes))}
          className="mt-4 inline-flex items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-foreground hover:border-gold/50 hover:text-gold-soft"
        >
          Exporter les notes <Download className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-gold-soft">
          Partage privé
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Préparez un lien et un message pour avocat, associé, artisan ou courtier. Les permissions
          fines seront à brancher côté compte.
        </p>
        <div className="mt-4 grid gap-2">
          {[
            "Inviter un avocat",
            "Inviter un associé",
            "Inviter un artisan",
            "Inviter un courtier",
          ].map((label) => (
            <button
              key={label}
              type="button"
              onClick={() => void copyText(`${label} : ${inviteText}`)}
              className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-foreground transition-colors hover:border-gold/50"
            >
              <span>{label}</span>
              <Share2 className="h-3.5 w-3.5 text-gold-soft" />
            </button>
          ))}
        </div>
        <textarea
          readOnly
          value={inviteText}
          className="mt-4 h-24 w-full resize-none rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
        />
      </div>
    </div>
  );
}

function NoteField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <textarea
        rows={3}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full resize-none rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        placeholder="Ajouter une note..."
      />
    </label>
  );
}

function SaleAlertsBlock({ sale }: { sale: AuctionSale }) {
  const alertOptions = [
    "Rappel avant audience",
    "Rappel avant visite",
    "Ajout d'un document",
    "Modification de la date",
    "Modification de la mise à prix",
    "Information d'occupation ajoutée",
    "Nouvelle vente similaire dans le secteur",
    "Changement sur les hypothèses de marché",
    "Rappel pour transmettre les consignes à l'avocat",
  ];
  const [alerts, setAlerts] = useLocalState<Record<string, boolean>>(
    saleStorageKey(sale.id, "sale-alerts"),
    {},
  );

  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <div className="grid gap-3 md:grid-cols-2">
        {alertOptions.map((label) => (
          <label
            key={label}
            className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 p-3 text-sm"
          >
            <span className="font-medium text-foreground">{label}</span>
            <input
              type="checkbox"
              checked={Boolean(alerts[label])}
              onChange={(event) =>
                setAlerts((current) => ({ ...current, [label]: event.target.checked }))
              }
              className="h-4 w-4 accent-[var(--gold)]"
            />
          </label>
        ))}
      </div>
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        Ces alertes sont enregistrées sur ce navigateur. La synchronisation compte/Supabase peut
        reprendre les mêmes libellés.
      </p>
    </div>
  );
}

function ComparisonBlock({
  sale,
  ceiling,
  cost,
}: {
  sale: AuctionSale;
  ceiling: MarketCeilingResult;
  cost: AcquisitionCost;
}) {
  const [comparison, setComparison] = useLocalState<string[]>("immojudis:comparison-list", []);
  const included = comparison.includes(sale.id);
  const toggle = () =>
    setComparison((current) =>
      current.includes(sale.id)
        ? current.filter((id) => id !== sale.id)
        : [...current, sale.id].slice(-6),
    );

  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <button
        type="button"
        onClick={toggle}
        className="inline-flex items-center gap-2 rounded-md bg-foreground px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-background hover:bg-foreground/90"
      >
        {included ? "Retirer de la comparaison" : "Comparer cette vente"}
      </button>
      <div className="mt-5 overflow-hidden rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <tbody className="divide-y divide-border">
            {[
              ["Mise à prix", formatPrice(sale.starting_price_eur)],
              [
                "Plafond recommandé",
                ceiling.available ? formatPrice(ceiling.maxBid) : "À compléter",
              ],
              ["Coût complet estimé", formatPrice(cost.totalCost)],
              ["Surface", getDisplaySurface(sale).label],
              ["Date d'audience", formatDate(sale.sale_date)],
              ["Tribunal", sale.tribunal ?? sale.tribunal_name ?? "À confirmer"],
              ["Occupation", occupancyLabel(sale.occupancy_status)],
              ["Documents disponibles", String(countDocuments(sale))],
              ["Point prioritaire", primaryCheckLabel(sale)],
            ].map(([label, value]) => (
              <tr key={label}>
                <th className="bg-muted/30 px-3 py-2 text-xs uppercase tracking-[0.12em] text-muted-foreground">
                  {label}
                </th>
                <td className="px-3 py-2 font-medium text-foreground">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Dossiers dans la comparaison locale : {comparison.length}. Les autres ventes seront visibles
        dès qu'une page comparateur dédiée lira cette liste.
      </p>
    </div>
  );
}

function SimilarPropertiesBlock({
  sale,
  marketEstimate,
}: {
  sale: AuctionSale;
  marketEstimate?: MarketEstimate | null;
}) {
  const transactions = marketEstimate?.recentTransactions ?? [];
  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      {transactions.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {transactions.slice(0, 4).map((transaction, index) => (
            <div
              key={`${transaction.date}-${index}`}
              className="rounded-md border border-border bg-muted/30 p-3"
            >
              <div className="text-sm font-semibold text-foreground">
                Vente comparable · {formatDate(transaction.date)}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {transaction.surface ? `${Math.round(transaction.surface)} m²` : "Surface inconnue"}{" "}
                · {formatPrice(transaction.totalPrice)} · {formatPricePerM2(transaction.pricePerM2)}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Les biens similaires seront affichés quand des comparables de ventes ou d'annonces seront
          disponibles pour {sale.city ?? "ce secteur"}.
        </p>
      )}
    </div>
  );
}

function FinalActionsBlock({ sale }: { sale: AuctionSale }) {
  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <FavoriteButton saleId={sale.id} className="justify-center px-4 py-3" />
        <a
          href="#assistant"
          className="inline-flex items-center justify-center gap-2 rounded-md bg-foreground px-4 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-background hover:bg-foreground/90"
        >
          Préparer mon enchère <Target className="h-3.5 w-3.5" />
        </a>
        <button
          type="button"
          onClick={printAnalysis}
          className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-white px-4 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-foreground hover:border-gold/50 hover:text-gold-soft"
        >
          Export PDF <Download className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void shareCurrentPage(sale.title ?? "Dossier Immojudis")}
          className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-white px-4 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-foreground hover:border-gold/50 hover:text-gold-soft"
        >
          Partager <Share2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-5 rounded-lg border border-border bg-muted/30 p-4">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Fonctions premium prêtes à brancher
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Export PDF complet, suivi de ventes, alertes personnalisées, comparateur, simulateur
          achat-revente, simulateur locatif, notes privées, partage avec avocat, lecture assistée et
          historique des changements.
        </p>
      </div>
    </div>
  );
}

function DecisionRail({
  sale,
  decision,
  acquisitionCost,
}: {
  sale: AuctionSale;
  decision: DecisionSummary;
  acquisitionCost: AcquisitionCost;
}) {
  const documentCount = countDocuments(sale);
  const ceilingLabel = decision.ceiling.available
    ? formatPrice(decision.ceiling.maxBid)
    : "À compléter";

  return (
    <div className="space-y-6">
      <div className="relative rounded-lg border border-border bg-white p-6 shadow-xl shadow-slate-900/10">
        <div className="text-[10px] uppercase tracking-[0.16em] text-gold-soft">
          Dossier à suivre
        </div>
        <div className="mt-4 rounded-lg border border-gold/20 bg-gold/[0.06] p-4">
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Plafond d'enchère recommandé
          </div>
          <div className="mt-2 text-4xl font-semibold leading-none tabular-nums text-foreground">
            {ceilingLabel}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {decision.primaryCheck}. À valider avec les pièces et les professionnels compétents.
          </p>
          <a
            href="#assistant"
            className="mt-3 inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-[0.12em] text-gold-soft transition-colors hover:text-gold"
          >
            Préparer mon enchère <ChevronRight className="h-3 w-3" />
          </a>
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-border pt-5">
          <RailMeta label="Mise à prix" value={formatPrice(sale.starting_price_eur)} />
          <RailMeta label="Coût complet" value={formatPrice(acquisitionCost.totalCost)} />
          <RailMeta label="Audience" value={formatDate(sale.sale_date)} />
          <RailMeta label="Occupation" value={occupancyLabel(sale.occupancy_status)} />
          <RailMeta
            label="Pièces"
            value={`${documentCount} disponible${documentCount > 1 ? "s" : ""}`}
          />
          <RailMeta label="Point à vérifier" value={decision.primaryDocument} />
        </dl>
        <div className="mt-5">
          <SaleCountdown date={sale.sale_date} variant="block" />
        </div>

        <div className="mt-5 grid gap-3 border-t border-border pt-5">
          <FavoriteButton saleId={sale.id} className="w-full justify-center" />
          <a
            href="#assistant"
            className="group flex w-full items-center justify-between rounded-lg bg-foreground px-4 py-3 text-[11px] font-medium uppercase tracking-[0.12em] text-background transition-colors hover:bg-foreground/90"
          >
            <span>Préparer mon enchère</span>
            <Target className="h-3.5 w-3.5" />
          </a>
          <button
            type="button"
            onClick={printAnalysis}
            className="group flex w-full items-center justify-between rounded-lg border border-border bg-white px-4 py-3 text-[11px] font-medium uppercase tracking-[0.12em] text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft"
          >
            <span>Exporter l'analyse</span>
            <Download className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void shareCurrentPage(sale.title ?? "Dossier Immojudis")}
            className="group flex w-full items-center justify-between rounded-lg border border-border bg-white px-4 py-3 text-[11px] font-medium uppercase tracking-[0.12em] text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft"
          >
            <span>Partager le dossier</span>
            <Share2 className="h-3.5 w-3.5" />
          </button>
          {sale.source_url && (
            <a
              href={sale.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex w-full items-center justify-between rounded-lg border border-border bg-white px-4 py-3 text-[11px] font-medium uppercase tracking-[0.12em] text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft"
            >
              <span>Source{sale.source_name ? ` · ${sale.source_name}` : ""}</span>
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function RailMeta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-medium tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

function MobileActionBar({ sale, decision }: { sale: AuctionSale; decision: DecisionSummary }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-white/95 px-3 py-2 shadow-[0_-8px_24px_rgb(19_34_56/10%)] backdrop-blur lg:hidden">
      <div className="mx-auto grid max-w-7xl grid-cols-[1fr_1fr_auto_auto] items-center gap-2">
        <a href="#assistant" className="min-w-0 rounded-md px-2 py-1.5 text-xs">
          <span className="block text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            Plafond
          </span>
          <span className="block truncate font-semibold text-foreground">
            {decision.ceiling.available ? formatPrice(decision.ceiling.maxBid) : "À compléter"}
          </span>
        </a>
        <div className="min-w-0 rounded-md px-2 py-1.5 text-xs">
          <span className="block text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            Audience
          </span>
          <span className="block truncate font-semibold text-foreground">
            {timeRemainingLabel(sale.sale_date)}
          </span>
        </div>
        <FavoriteButton saleId={sale.id} className="h-10 justify-center px-2 text-[10px]" />
        <button
          type="button"
          onClick={printAnalysis}
          className="grid h-10 w-10 place-items-center rounded-md border border-border text-foreground"
          aria-label="Exporter l'analyse"
        >
          <Download className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function buildDecisionSummary(
  sale: AuctionSale,
  marketEstimate: MarketEstimate | null | undefined,
): DecisionSummary {
  const balancedScenario =
    MARKET_CEILING_SCENARIOS.find((scenario) => scenario.key === "equilibre") ??
    MARKET_CEILING_SCENARIOS[1];
  const ceiling = computeMarketCeiling({
    surface: getSaleSurface(sale).value,
    price: Math.max(0, sale.starting_price_eur ?? 0),
    works: DEFAULTS.works,
    fpt: DEFAULTS.fpt,
    scenario: balancedScenario.key,
    medianPricePerM2: marketEstimate?.medianPricePerM2,
    p25PricePerM2: marketEstimate?.p25PricePerM2,
    p75PricePerM2: marketEstimate?.p75PricePerM2,
  });

  const primaryCheck = primaryCheckLabel(sale);
  return {
    ceiling,
    primaryCheck,
    primaryDocument: primaryDocumentLabel(sale, primaryCheck),
    action: recommendedAction(sale, ceiling),
    dossierStatus:
      countDocuments(sale) > 0
        ? "Exploitable, sous réserve de validation des pièces"
        : "À compléter avant décision",
  };
}

function primaryCheckLabel(sale: AuctionSale): string {
  if (isUnknownOccupation(sale.occupancy_status)) return "Occupation du bien non confirmée";
  if (hasWorksRisk(sale)) return "Budget travaux à confirmer";
  if (!hasDocumentType(sale, /cahier|conditions/)) return "Cahier des conditions à récupérer";
  if (!hasDocumentType(sale, /diagnostic|dpe|amiante|plomb/)) return "Diagnostics à rechercher";
  return "Frais et conditions à relire avant consignes";
}

function primaryDocumentLabel(sale: AuctionSale, primaryCheck: string): string {
  const normalized = primaryCheck.toLowerCase();
  if (normalized.includes("occupation")) return "PV descriptif";
  if (normalized.includes("travaux")) return "PV descriptif ou diagnostics";
  if (normalized.includes("diagnostic")) return "Diagnostics techniques";
  if (hasDocumentType(sale, /cahier|conditions/)) return "Cahier des conditions de vente";
  return "Cahier des conditions";
}

function recommendedAction(sale: AuctionSale, ceiling: MarketCeilingResult): string {
  if (!ceiling.available) return "Renseigner le marché local";
  if (isUnknownOccupation(sale.occupancy_status)) return "Faire confirmer l'occupation";
  if (hasWorksRisk(sale)) return "Chiffrer les travaux";
  if (!hasDocumentType(sale, /cahier|conditions/)) return "Obtenir le cahier des conditions";
  return "Faire relire les conditions de vente";
}

function buildVerificationPoints(sale: AuctionSale): Array<{
  label: string;
  detail: string;
  status: string;
  tone: "verified" | "watch" | "missing" | "risk";
}> {
  const unknownOccupation = isUnknownOccupation(sale.occupancy_status);
  const hasDiagnostics = hasDocumentType(sale, /diagnostic|dpe|amiante|plomb|termite/);
  const hasConditions = hasDocumentType(sale, /cahier|conditions/);
  const hasPv = hasDocumentType(sale, /pv|descriptif|huissier|commissaire/);
  const worksRisk = hasWorksRisk(sale);

  return [
    {
      label: "Occupation du bien",
      detail: unknownOccupation
        ? "Statut à confirmer dans le PV descriptif avant de figer le plafond."
        : `${occupancyLabel(sale.occupancy_status)} : vérifier le titre et le délai de libération.`,
      status: unknownOccupation ? "À confirmer" : "Document disponible",
      tone: unknownOccupation ? "watch" : "verified",
    },
    {
      label: "État intérieur et travaux",
      detail: worksRisk
        ? "Un point travaux est détecté : il doit devenir une enveloppe chiffrée."
        : "Aucun budget travaux fiable n'est encore saisi dans les hypothèses.",
      status: worksRisk ? "À chiffrer" : "À confirmer",
      tone: worksRisk ? "risk" : "watch",
    },
    {
      label: "Diagnostics",
      detail:
        "Relire les diagnostics pour amiante, plomb, DPE, termites et contraintes techniques.",
      status: hasDiagnostics ? "Document disponible" : "Document manquant",
      tone: hasDiagnostics ? "verified" : "missing",
    },
    {
      label: "Conditions de vente",
      detail:
        "Vérifier clauses particulières, frais, consignation, délai de paiement et surenchère.",
      status: hasConditions ? "À faire relire" : "Document manquant",
      tone: hasConditions ? "watch" : "missing",
    },
    {
      label: "PV descriptif",
      detail: "Source prioritaire pour occupation, accès au bien, état visible et équipements.",
      status: hasPv ? "Document disponible" : "Document manquant",
      tone: hasPv ? "verified" : "missing",
    },
    {
      label: "Financement et avocat",
      detail: "Valider la capacité de paiement et le mandat d'avocat avant l'audience.",
      status: "À valider",
      tone: "watch",
    },
  ];
}

function hasWorksRisk(sale: AuctionSale): boolean {
  return (sale.risks ?? []).some((risk) =>
    `${risk.risk_label ?? ""} ${risk.risk_type ?? ""}`
      .toLowerCase()
      .match(/travaux|renov|état|etat/),
  );
}

function isUnknownOccupation(status: string | null | undefined): boolean {
  const normalized = (status ?? "").toLowerCase();
  return !status || normalized === "unknown" || normalized === "inconnu";
}

function hasDocumentType(sale: AuctionSale, pattern: RegExp): boolean {
  return documentSearchParts(sale).some((part) => pattern.test(part.toLowerCase()));
}

function documentSearchParts(sale: AuctionSale): string[] {
  const rich = (sale.documents_rich ?? []).flatMap((document) => [
    document.label,
    document.type,
    document.document_type,
    document.url,
  ]);
  const basic = parseDocs(sale.documents).flatMap((document) => [
    document.name,
    document.type,
    document.url,
  ]);
  return [...rich, ...basic].filter((part): part is string => Boolean(part));
}

function countDocuments(sale: AuctionSale): number {
  const richCount = sale.documents_rich?.length ?? 0;
  return richCount > 0 ? richCount : parseDocs(sale.documents).length;
}

function documentReviewPrompt(document: SaleDocumentRich): string {
  const type = `${document.document_type ?? ""} ${document.type ?? ""}`.toLowerCase();
  if (/pv|descriptif|huissier|commissaire/.test(type)) {
    return "Relire l'occupation, l'accès, l'état intérieur, les travaux apparents et les équipements visibles.";
  }
  if (/cahier|conditions/.test(type)) {
    return "Vérifier les clauses particulières, frais, consignation, délai de paiement, servitudes et surenchère.";
  }
  if (/diagnostic|dpe|amiante|plomb|termite/.test(type)) {
    return "Identifier les contraintes techniques qui peuvent modifier les travaux, le délai ou la revente.";
  }
  if (/bail|occupation/.test(type)) {
    return "Vérifier le titre d'occupation, le loyer, la durée, les conditions de sortie et les impayés éventuels.";
  }
  return "Relire les passages qui peuvent modifier le plafond, les frais, l'occupation ou les travaux.";
}

function documentPagesToReview(sale: AuctionSale, document: SaleDocumentRich): string | null {
  const documentType = document.document_type ?? document.type;
  const pages = new Set<number>();
  for (const risk of sale.risks ?? []) {
    for (const occurrence of risk.occurrences ?? []) {
      const sameType = documentType && occurrence.document_type === documentType;
      const sameLabel = occurrence.document_label && occurrence.document_label === document.label;
      if ((sameType || sameLabel) && occurrence.page_number != null) {
        pages.add(occurrence.page_number);
      }
    }
  }
  return pages.size ? [...pages].sort((a, b) => a - b).join(", ") : null;
}

function answerDossierQuestion(
  question: string,
  sale: AuctionSale,
  cost: AcquisitionCost,
  ceiling: MarketCeilingResult,
): { text: string; source: string; excerpt?: string } {
  const normalized = normalizeLocation(question);
  const priorityDocument = primaryDocumentLabel(sale, primaryCheckLabel(sale));

  if (/occupe|occupation/.test(normalized)) {
    const occurrence = findOccurrence(sale, /occupation|occupe|occupant|bail|locataire/);
    return {
      text: `Statut lu : ${occupancyLabel(sale.occupancy_status)}. Si l'information reste imprécise, c'est un point bloquant pour le plafond, car l'occupation peut déplacer le calendrier, les travaux et la jouissance.`,
      source: occurrence?.document_label ?? priorityDocument,
      excerpt: occurrence?.excerpt ?? undefined,
    };
  }

  if (/document|piece|relire/.test(normalized)) {
    const documents = documentNames(sale).slice(0, 4);
    return {
      text: documents.length
        ? `Relire en priorité : ${documents.join(", ")}. Commencer par ce qui confirme l'occupation, les conditions de vente, les diagnostics et les travaux.`
        : "Aucune pièce structurée n'est encore disponible. Le dossier doit être complété avant de fixer une enchère.",
      source: documents.length ? "Pièces indexées du dossier" : "Aucune pièce indexée",
    };
  }

  if (/frais|prevoir|avocat|adjudication/.test(normalized)) {
    return {
      text: `À ce stade, les frais simulés représentent ${formatPrice(cost.acquisitionFeesTotal)} : émoluments, droits, taxes et frais de procédure estimés. Ajouter les frais spécifiques du cahier des conditions dans la simulation.`,
      source: "Simulation de coût complet",
    };
  }

  if (/plafond|modifier|element/.test(normalized)) {
    return {
      text: ceiling.available
        ? `Le plafond actuel est ${formatPrice(ceiling.maxBid)}. Il peut bouger avec l'occupation, les travaux, les frais particuliers, la surface retenue et le prix/m² local.`
        : "Le plafond n'est pas encore disponible : il manque une surface exploitable ou une référence de marché local.",
      source: "Assistant de mise plafond",
    };
  }

  if (/avocat|demander/.test(normalized)) {
    return {
      text: "Demander confirmation de la consignation, des frais particuliers, du délai de paiement, du délai de surenchère, des clauses du cahier des conditions et de toute incertitude d'occupation.",
      source: "Checklist avant audience",
    };
  }

  if (/travaux|etat|renovation/.test(normalized)) {
    const risk = (sale.risks ?? []).find((item) =>
      `${item.risk_label ?? ""} ${item.risk_type ?? ""}`
        .toLowerCase()
        .match(/travaux|renov|etat|état/),
    );
    return {
      text: risk
        ? `${risk.risk_label || "Travaux à prévoir"} : ${risk.evidence ?? "un point travaux est détecté, à transformer en budget."}`
        : "Aucun poste travaux fiable n'est détecté. Saisir une enveloppe basse, médiane et haute avant l'audience.",
      source: risk?.occurrences?.[0]?.document_label ?? "Bloc travaux",
      excerpt: risk?.occurrences?.[0]?.excerpt ?? undefined,
    };
  }

  if (/cout|complet|total/.test(normalized)) {
    return {
      text: `Le coût complet estimé ressort à ${formatPrice(cost.totalCost)}, dont ${formatPrice(cost.acquisitionFeesTotal)} de frais d'acquisition et ${formatPrice(cost.works)} de travaux saisis.`,
      source: "Coût complet d'acquisition",
    };
  }

  if (/prix|interessante|interessant/.test(normalized)) {
    return {
      text: ceiling.available
        ? `L'opération devient moins intéressante au-dessus de ${formatPrice(ceiling.maxBid)}, hors nouvelle information favorable sur le marché, les travaux ou l'occupation.`
        : "Impossible de fixer ce seuil sans plafond calculable. Compléter le marché local et les hypothèses de travaux/frais.",
      source: "Plafond recommandé",
    };
  }

  return {
    text: `Point prioritaire : ${primaryCheckLabel(sale)}. Relire ${priorityDocument} avant de figer les consignes.`,
    source: priorityDocument,
  };
}

function findOccurrence(sale: AuctionSale, pattern: RegExp): SaleRiskOccurrence | undefined {
  return riskOccurrences(sale).find((occurrence) =>
    `${occurrence.document_label ?? ""} ${occurrence.document_type ?? ""} ${occurrence.excerpt ?? ""}`
      .toLowerCase()
      .match(pattern),
  );
}

function documentNames(sale: AuctionSale): string[] {
  const rich = sale.documents_rich ?? [];
  if (rich.length) return rich.map((document) => documentName(document));
  return parseDocs(sale.documents).map((document) => document.name ?? document.url);
}

function documentName(document: SaleDocumentRich): string {
  return (
    document.label ??
    document.url.split("/").filter(Boolean).pop() ??
    documentTypeLabel(document.document_type ?? document.type)
  );
}

function notesToText(sale: AuctionSale, notes: StoredNotes): string {
  const title = sale.title ?? propertyTypeLabel(sale.property_type);
  return [
    `Dossier Immojudis : ${title}`,
    `Lieu : ${saleLocation(sale.address, sale.postal_code, sale.city) || "À confirmer"}`,
    `Audience : ${formatDate(sale.sale_date)}`,
    `Notes privées : ${notes.privateMode ? "oui" : "non"}`,
    "",
    "Note générale",
    notes.general || "—",
    "",
    "Occupation",
    notes.occupation || "—",
    "",
    "Travaux",
    notes.works || "—",
    "",
    "Marché local",
    notes.market || "—",
  ].join("\n");
}

async function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  if (typeof document === "undefined") return;
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.left = "-9999px";
  document.body.appendChild(field);
  field.select();
  document.execCommand("copy");
  document.body.removeChild(field);
}

function downloadText(filename: string, text: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
}

function timeRemainingLabel(value: string | null | undefined): string {
  if (!value) return "À confirmer";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "À confirmer";
  const diff = date.getTime() - Date.now();
  const day = 24 * 60 * 60 * 1000;
  if (diff < -day) return "Audience passée";
  if (diff <= 0) return "Aujourd'hui";
  const days = Math.ceil(diff / day);
  if (days === 1) return "Demain";
  return `${days} jours`;
}

function printAnalysis() {
  if (typeof window !== "undefined") window.print();
}

async function shareCurrentPage(title: string) {
  if (typeof window === "undefined") return;
  const url = window.location.href;
  if (navigator.share) {
    await navigator.share({ title, url });
    return;
  }
  await navigator.clipboard?.writeText(url);
}

function saleLocation(
  address: string | null | undefined,
  postalCode: string | null | undefined,
  city: string | null | undefined,
): string {
  const cleanedAddress = cleanLocationPart(address);
  const normalizedAddress = normalizeLocation(cleanedAddress);
  const postalAndCity = [postalCode, city].filter(Boolean).join(" ").trim();
  const parts: string[] = [];

  if (cleanedAddress) parts.push(cleanedAddress);
  if (postalAndCity && !normalizedAddress.includes(normalizeLocation(postalCode))) {
    parts.push(postalAndCity);
  } else if (city && !normalizedAddress.includes(normalizeLocation(city))) {
    parts.push(city);
  }

  return parts
    .filter(Boolean)
    .filter((part, index, values) => {
      const normalized = normalizeLocation(part);
      return values.findIndex((candidate) => normalizeLocation(candidate) === normalized) === index;
    })
    .join(", ");
}

function cleanLocationPart(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\s*,?\s*France\s*$/i, "")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLocation(value: string | null | undefined): string {
  return cleanLocationPart(value)
    .toLocaleLowerCase("fr-FR")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

function HeroMeta({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</dt>
      <dd
        className={
          accent
            ? "mt-1.5 text-2xl font-semibold tabular-nums text-foreground"
            : "mt-2 text-base font-medium tabular-nums text-foreground"
        }
      >
        {value}
      </dd>
    </div>
  );
}

function Section({
  id,
  eyebrow,
  title,
  children,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <header className="mb-5 flex items-baseline gap-4">
        <span className="text-[10px] uppercase tracking-[0.16em] text-gold-soft">{eyebrow}</span>
        <span className="h-px flex-1 bg-border" />
      </header>
      <h2 className="font-sans text-2xl font-semibold text-foreground sm:text-[1.75rem]">
        {title}
      </h2>
      <div className="mt-6">{children}</div>
    </section>
  );
}

function FoldableSection({
  id,
  eyebrow,
  title,
  summary,
  children,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <details className="group rounded-lg border border-border bg-white p-5 shadow-sm">
        <summary className="flex cursor-pointer list-none items-start justify-between gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.16em] text-gold-soft">{eyebrow}</div>
            <h2 className="mt-3 font-sans text-2xl font-semibold text-foreground sm:text-[1.75rem]">
              {title}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{summary}</p>
          </div>
          <ChevronRight className="mt-3 h-5 w-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        </summary>
        <div className="mt-5 border-t border-border pt-5">{children}</div>
      </details>
    </section>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">{label}</dt>
      <dd className="mt-1.5 text-sm font-medium text-foreground">{value}</dd>
    </div>
  );
}

export function SaleDetailSkeleton() {
  return (
    <main className="min-h-screen bg-white px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-7xl">
        <Skeleton className="h-4 w-20 bg-muted" />
        <Skeleton className="mt-4 h-8 w-2/3 bg-muted" />
        <Skeleton className="mt-2 h-4 w-1/2 bg-muted" />
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <Skeleton className="h-96 w-full rounded-lg bg-muted" />
            <Skeleton className="h-40 w-full rounded-lg bg-muted" />
            <Skeleton className="h-32 w-full rounded-lg bg-muted" />
          </div>
          <aside className="space-y-4">
            <Skeleton className="h-48 w-full rounded-lg bg-muted" />
            <Skeleton className="h-32 w-full rounded-lg bg-muted" />
          </aside>
        </div>
      </div>
    </main>
  );
}

export function SaleNotFoundComponent() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-4 py-16 text-center">
      <div className="max-w-2xl rounded-lg border border-border bg-white p-8 shadow-xl shadow-slate-900/10">
        <BrandMark className="mx-auto h-14 w-14" />
        <h1 className="mt-5 font-sans text-2xl font-semibold text-foreground">
          Annonce introuvable
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Cette vente n'existe plus ou a été retirée. Elle peut avoir été adjugée ou supprimée par
          la source.
        </p>
        <Link
          to="/sales"
          className="mt-6 inline-flex items-center rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-foreground/90"
        >
          ← Retour aux annonces
        </Link>
      </div>
    </main>
  );
}

export function SaleErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-4 py-16 text-center">
      <div className="max-w-2xl rounded-lg border border-border bg-white p-8 shadow-xl shadow-slate-900/10">
        <h1 className="font-sans text-2xl font-semibold text-foreground">
          Impossible d'afficher cette annonce
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-foreground/90"
          >
            Réessayer
          </button>
          <Link
            to="/sales"
            className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium hover:border-gold"
          >
            ← Retour aux annonces
          </Link>
        </div>
      </div>
    </main>
  );
}
