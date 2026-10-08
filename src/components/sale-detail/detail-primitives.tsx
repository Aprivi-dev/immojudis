import { Link } from "@/lib/router-compat";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import ClipboardCheck from "lucide-react/dist/esm/icons/clipboard-check.js";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import { formatPrice, formatDate } from "@/lib/format";
import { FavoriteButton } from "@/components/FavoriteButton";
import { EvidenceTrail } from "@/components/EvidenceTrail";
import { type CarouselImage } from "@/components/PhotoCarouselDialog";
import { propertyImages } from "@/lib/sale-media";
import { saleSourceLinks } from "@/lib/sale-source-links";
import { type ProductGroup, type SaleProductSources } from "@/lib/sale-detail-sources";
import type { AuctionSale, SaleMedia } from "@/lib/types";
import type { AcquisitionCost, DecisionSummary } from "./decision-view";
import { isExternalHref, lawyerQuestions } from "./detail-helpers";
import { CostRow, DocumentsWorkspace } from "./document-workspace";
export const SECTION_NAV = [
  { id: "summary", label: "Résumé" },
  { id: "verdict", label: "Verdict" },
  { id: "figures", label: "Chiffres" },
  { id: "risks", label: "Risques" },
  { id: "calculation", label: "Calcul" },
  { id: "proofs", label: "Preuves" },
  { id: "steps", label: "Étapes" },
  { id: "faq", label: "FAQ" },
  { id: "technical-details", label: "Détails" },
] as const;

export function LawyerQuestionsBlock({
  sale,
  decision,
  acquisitionCost,
}: {
  sale: AuctionSale;
  decision: DecisionSummary;
  acquisitionCost: AcquisitionCost;
}) {
  return (
    <div className="rounded-lg border border-border bg-white p-4 shadow-sm">
      <dl className="grid gap-3 rounded-md border border-border bg-muted/30 p-3 text-sm sm:grid-cols-2">
        <CostRow label="Audience" value={formatDate(sale.sale_date)} />
        <CostRow label="Tribunal" value={sale.tribunal ?? sale.tribunal_name ?? "À confirmer"} />
        <CostRow
          label="Plafond"
          value={decision.ceiling.available ? formatPrice(decision.ceiling.maxBid) : "À compléter"}
        />
        <CostRow label="Coût complet" value={formatPrice(acquisitionCost.totalCost)} />
      </dl>
      <LawyerQuestionsList questions={lawyerQuestions(sale)} />
    </div>
  );
}

export function LawyerQuestionsList({ questions }: { questions: string[] }) {
  return (
    <div className="mt-4 rounded-md border border-border bg-muted/30 p-3">
      <div className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        Questions à préparer
      </div>
      <ul className="mt-3 grid gap-2 text-sm leading-relaxed text-muted-foreground">
        {questions.map((question) => (
          <li key={question} className="flex gap-2">
            <ClipboardCheck className="mt-0.5 h-4 w-4 shrink-0 text-gold-soft" />
            <span>{question}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RedfinPropertyDetailsBlock({ groups }: { groups: ProductGroup[] }) {
  return (
    <div>
      <div className="grid gap-6 md:grid-cols-2">
        {groups.map((group) => (
          <section key={group.title}>
            <h3 className="text-base font-semibold text-foreground">{group.title}</h3>
            <dl className="mt-3 divide-y divide-border">
              {group.facts.map((fact) => (
                <div
                  key={`${group.title}-${fact.label}`}
                  className="grid grid-cols-[150px_1fr] gap-4 py-2 text-sm"
                >
                  <dt className="text-muted-foreground">{fact.label}</dt>
                  <dd className="font-medium text-foreground">{fact.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}

export function SourcesAndDocumentsBlock({
  sale,
  product,
}: {
  sale: AuctionSale;
  product: SaleProductSources;
}) {
  const links = saleSourceLinks(sale);

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-white p-4 shadow-sm">
        <div className="grid gap-4 sm:grid-cols-[1fr_240px]">
          <dl className="grid gap-2 sm:grid-cols-2">
            {product.sourceFacts.map((fact) => (
              <div key={fact.label} className="rounded-md border border-border bg-muted/30 p-3">
                <dt className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  {fact.label}
                </dt>
                <dd className="mt-1 text-sm font-semibold text-foreground">{fact.value}</dd>
                {fact.detail && (
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {fact.detail}
                  </p>
                )}
              </div>
            ))}
          </dl>
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <div className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Liens source
            </div>
            {links.length > 0 ? (
              <div className="mt-3 grid gap-2">
                {links.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    target={isExternalHref(link.href) ? "_blank" : undefined}
                    rel={isExternalHref(link.href) ? "noopener noreferrer" : undefined}
                    className="inline-flex items-center justify-between gap-2 rounded-md border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft"
                  >
                    <span className="truncate">{link.label}</span>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                  </a>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                Aucun lien source n'est encore attaché à cette annonce.
              </p>
            )}
          </div>
        </div>
      </div>
      <DocumentsWorkspace sale={sale} />
      <EvidenceTrail sale={sale} />
    </div>
  );
}

export function ListingActionBar({
  sale,
  title,
  location,
  returnTo,
}: {
  sale: AuctionSale;
  title: string;
  location: string;
  returnTo: string;
}) {
  return (
    <nav className="sticky top-16 z-40 border-b border-border bg-white/95 backdrop-blur">
      <div className="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-1.5 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to={returnTo}
            className="inline-flex min-h-11 shrink-0 items-center gap-1 text-[11px] font-semibold text-gold-soft hover:text-gold"
          >
            <ChevronRight className="h-3 w-3 rotate-180" />
            Retour
          </Link>
          <div className="hidden items-center gap-4 overflow-x-auto text-[11px] font-semibold text-muted-foreground md:flex">
            {SECTION_NAV.map((s) => (
              <a key={s.id} href={`#${s.id}`} className="shrink-0 hover:text-foreground">
                {s.label}
              </a>
            ))}
          </div>
          <span className="truncate text-[11px] text-muted-foreground md:hidden">
            {location || title}
          </span>
        </div>
        <div className="hidden shrink-0 items-center gap-2 sm:flex">
          <a
            href="#calculation"
            className="inline-flex min-h-11 items-center justify-center rounded-md bg-foreground px-3 py-1.5 text-xs font-semibold text-background transition-colors hover:bg-foreground/90"
          >
            Ajuster mon plafond
          </a>
          <FavoriteButton
            saleId={sale.id}
            className="min-h-11 border border-border bg-white px-3 py-1.5 text-xs shadow-none"
          />
        </div>
      </div>
    </nav>
  );
}

export function saleMapboxLocation(sale: AuctionSale): { lat: number; lng: number } | null {
  if (sale.latitude != null && sale.longitude != null) {
    return { lat: sale.latitude, lng: sale.longitude };
  }
  return null;
}

export function saleMediaCarouselImages(media: SaleMedia[], title: string): CarouselImage[] {
  return media.map((item, index) => ({
    id: `${item.url}-${index}`,
    url: item.url,
    alt: index === 0 ? `Photo principale de ${title}` : `Photo ${index + 1} de ${title}`,
    source: item.source,
  }));
}

export function saleImages(media: AuctionSale["media"] | undefined): SaleMedia[] {
  return propertyImages(media);
}
