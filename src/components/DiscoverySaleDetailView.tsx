"use client";

import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.js";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days.js";
import ChartNoAxesCombined from "lucide-react/dist/esm/icons/chart-no-axes-combined.js";
import FileSearch from "lucide-react/dist/esm/icons/file-search.js";
import Gavel from "lucide-react/dist/esm/icons/gavel.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import Ruler from "lucide-react/dist/esm/icons/ruler.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.js";
import { BillingActions } from "@/components/BillingActions";
import { PremiumPreview } from "@/components/PremiumPreview";
import { Button } from "@/components/ui/button";
import { formatDate, formatPrice, propertyTypeLabel } from "@/lib/format";
import { Link } from "@/lib/router-compat";
import { saleDisplayTitle } from "@/lib/sale-title";
import { firstPropertyImage } from "@/lib/sale-media";
import { getDisplaySurface } from "@/lib/surface";
import type { AuctionSale } from "@/lib/types";

const PLACEHOLDER_METRICS = [
  ["Valeur estimée", "164 000 €"],
  ["Décote calculée", "− 27 %"],
  ["Confiance", "Élevée"],
  ["Comparables DVF", "11 ventes"],
] as const;

export function DiscoverySaleDetailView({ sale }: { sale: AuctionSale }) {
  const title = saleDisplayTitle(sale, propertyTypeLabel(sale.property_type));
  const location = [sale.address, sale.postal_code, sale.city].filter(Boolean).join(", ");
  const surface = getDisplaySurface(sale);
  const image = firstPropertyImage(sale.media);

  return (
    <main className="min-h-screen bg-muted/30 text-foreground">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <Button asChild variant="ghost" size="sm">
          <Link to="/sales">
            <ArrowLeft data-icon="inline-start" aria-hidden />
            Retour aux ventes
          </Link>
        </Button>

        <section className="mt-4 overflow-hidden rounded-lg border border-border bg-card shadow-sm">
          <div className="grid lg:grid-cols-[minmax(0,1.1fr)_minmax(22rem,0.9fr)]">
            <div className="relative min-h-64 overflow-hidden bg-muted lg:min-h-[28rem]">
              {image ? (
                <img
                  src={image}
                  alt={title}
                  className="absolute inset-0 size-full object-cover"
                  referrerPolicy="strict-origin-when-cross-origin"
                />
              ) : (
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,hsl(var(--primary)/0.18),transparent_38%),linear-gradient(145deg,hsl(var(--muted)),hsl(var(--background)))]" />
              )}
              <span className="absolute left-4 top-4 rounded-full border border-white/35 bg-background/90 px-3 py-1 text-xs font-bold uppercase tracking-[0.12em] text-foreground shadow-sm">
                Offre Découverte
              </span>
            </div>

            <div className="flex flex-col p-5 sm:p-7">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-primary">
                Annonce judiciaire
              </p>
              <h1 className="mt-3 font-display text-3xl leading-tight sm:text-4xl">{title}</h1>
              <p className="mt-3 flex items-start gap-2 text-sm text-muted-foreground">
                <MapPin className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                {location || "Localisation à confirmer"}
              </p>

              <dl className="mt-6 grid grid-cols-2 gap-3">
                <DiscoveryMetric label="Mise à prix" value={formatPrice(sale.starting_price_eur)} />
                <DiscoveryMetric label="Audience" value={formatDate(sale.sale_date)} />
                <DiscoveryMetric
                  label="Surface"
                  value={surface.value ? surface.label : "À confirmer"}
                />
                <DiscoveryMetric
                  label="Tribunal"
                  value={sale.tribunal_city ?? sale.tribunal_name ?? sale.tribunal ?? "À confirmer"}
                />
              </dl>

              <div className="mt-6 rounded-lg border border-primary/20 bg-primary/5 p-4">
                <div className="flex items-center gap-2 text-sm font-extrabold">
                  <Sparkles className="size-4 text-primary" aria-hidden />
                  L'annonce est visible. L'analyse complète est verrouillée.
                </div>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  Un paiement unique de 29 € débloque toutes les informations et tous les outils
                  ci-dessous pendant 30 jours, sans abonnement récurrent.
                </p>
                <BillingActions className="mt-4" />
              </div>
            </div>
          </div>
        </section>

        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <PremiumPreview
            title="Estimation, décote et comparables DVF"
            description="Valeur de marché, ventes comparables retenues, prix au m² et niveau de confiance."
          >
            <div className="grid grid-cols-2 gap-3">
              {PLACEHOLDER_METRICS.map(([label, value]) => (
                <PlaceholderMetric key={label} label={label} value={value} />
              ))}
            </div>
            <div className="mt-4 h-24 rounded-md bg-gradient-to-r from-primary/10 via-primary/30 to-primary/5" />
          </PremiumPreview>

          <PremiumPreview
            title="Risques et lecture des pièces"
            description="Documents officiels, occupation, copropriété, servitudes et points à valider avec l'avocat."
          >
            <div className="flex items-center gap-3">
              <ShieldCheck className="size-8 text-primary" aria-hidden />
              <div>
                <p className="font-extrabold">8 pièces analysées</p>
                <p className="text-sm text-muted-foreground">3 points d'attention détectés</p>
              </div>
            </div>
            <ul className="mt-4 grid gap-2 text-sm">
              <li className="rounded-md border p-3">Occupation et délai de libération</li>
              <li className="rounded-md border p-3">Charges, servitudes et diagnostics</li>
              <li className="rounded-md border p-3">Questions préparées pour l'avocat</li>
            </ul>
          </PremiumPreview>

          <PremiumPreview
            title="Budget total et mise maximale"
            description="Frais d'adjudication, travaux, marge de sécurité et plafond à ne pas dépasser."
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <PlaceholderMetric label="Frais estimés" value="15 200 €" />
              <PlaceholderMetric label="Travaux" value="24 000 €" />
              <PlaceholderMetric label="Mise maximale" value="128 500 €" />
            </div>
            <div className="mt-4 rounded-md border p-3 text-sm">
              Scénarios rendement, revente et marge cible
            </div>
          </PremiumPreview>

          <PremiumPreview
            title="Cadastre, DPE et urbanisme"
            description="Parcelle, diagnostics énergétiques, PLU, permis, façade et contraintes documentées."
          >
            <div className="grid grid-cols-[1.2fr_0.8fr] gap-3">
              <div className="h-40 rounded-md bg-primary/15" />
              <div className="grid gap-3">
                <PlaceholderMetric label="Parcelle" value="Identifiée" />
                <PlaceholderMetric label="DPE" value="Classe C" />
                <PlaceholderMetric label="PLU" value="Zone UC" />
              </div>
            </div>
          </PremiumPreview>

          <PremiumPreview
            title="Quartier, services et dynamique locale"
            description="Démographie, transports, commerces, tension du marché et évolution des prix."
          >
            <div className="flex items-end gap-2">
              {[42, 68, 54, 82, 74, 92].map((height, index) => (
                <div
                  key={index}
                  className="flex-1 rounded-t bg-primary/30"
                  style={{ height: `${height}px` }}
                />
              ))}
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3">
              <PlaceholderMetric label="Services" value="27" />
              <PlaceholderMetric label="Rotation" value="Rapide" />
              <PlaceholderMetric label="Prix 3 ans" value="+ 8,4 %" />
            </div>
          </PremiumPreview>

          <PremiumPreview
            title="Suivi de dossier et avocat"
            description="Favoris, alertes, notes, checklist, exports et mise en relation avec un avocat référencé."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <PlaceholderFeature icon={CalendarDays} label="Checklist avant audience" />
              <PlaceholderFeature icon={FileSearch} label="Documents centralisés" />
              <PlaceholderFeature icon={ChartNoAxesCombined} label="Alertes et historique" />
              <PlaceholderFeature icon={Gavel} label="Avocat référencé" />
            </div>
          </PremiumPreview>
        </div>
      </div>
    </main>
  );
}

function DiscoveryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 text-sm font-extrabold text-foreground">{value}</dd>
    </div>
  );
}

function PlaceholderMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-lg font-extrabold text-foreground">{value}</p>
    </div>
  );
}

function PlaceholderFeature({ icon: Icon, label }: { icon: typeof Ruler; label: string }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-background p-3 text-sm font-bold">
      <Icon className="size-5 text-primary" aria-hidden />
      {label}
    </div>
  );
}
