import type { ReactNode } from "react";
import Banknote from "lucide-react/dist/esm/icons/banknote.js";
import BedDouble from "lucide-react/dist/esm/icons/bed-double.js";
import Bath from "lucide-react/dist/esm/icons/bath.js";
import CalendarClock from "lucide-react/dist/esm/icons/calendar-clock.js";
import Car from "lucide-react/dist/esm/icons/car.js";
import DoorOpen from "lucide-react/dist/esm/icons/door-open.js";
import Home from "lucide-react/dist/esm/icons/home.js";
import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import LayoutGrid from "lucide-react/dist/esm/icons/layout-grid.js";
import Ruler from "lucide-react/dist/esm/icons/ruler.js";
import ShieldQuestion from "lucide-react/dist/esm/icons/shield-question.js";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.js";
import Trees from "lucide-react/dist/esm/icons/trees.js";
import {
  formatDate,
  formatPrice,
  formatSurface,
  occupancyLabel,
  propertyTypeLabel,
  surfaceSourceLabel,
} from "@/lib/format";
import type { AuctionSale } from "@/lib/types";

const EQUIPMENTS: Array<[keyof AuctionSale, string]> = [
  ["has_garden", "Jardin"],
  ["has_terrace", "Terrasse"],
  ["has_garage", "Garage"],
  ["has_pool", "Piscine"],
  ["has_air_conditioning", "Climatisation"],
  ["has_double_glazing", "Double vitrage"],
];

/**
 * "Fiche d'identité" du bien : présente, de façon scannable, tout ce qu'Immojudis
 * a réussi à extraire du dossier (logement, occupation, équipements, cadre de la
 * vente, fiabilité des données et points à vérifier).
 */
export function PropertyOverview({ sale }: { sale: AuctionSale }) {
  const primarySurface = sale.app_surface_m2 ?? sale.habitable_surface_m2 ?? sale.carrez_surface_m2;
  const surfaceKind = sale.app_surface_kind ? ` (${sale.app_surface_kind})` : "";
  const propertyType = (sale.property_type ?? "").toLowerCase();
  const showLand =
    sale.land_surface_m2 != null &&
    /land|terrain|house|maison|building|immeuble/.test(propertyType);
  const equipments = EQUIPMENTS.filter(([key]) => sale[key] === true).map(([, label]) => label);
  const risks = sale.risks ?? [];
  const documentCount = sale.documents_rich?.length ?? 0;
  const surfaceConfidence =
    sale.surface_confidence != null ? Math.round(sale.surface_confidence * 100) : null;
  const surfaceSource = surfaceSourceLabel(sale.surface_source);

  return (
    <div className="liquid-panel rounded-lg p-5 sm:p-6">
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Immojudis a lu le dossier et en a extrait les informations ci-dessous. Elles servent de base
        au calcul de la mise plafond.
      </p>

      {/* ── Faits clés ───────────────────────────────────────────────────── */}
      <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Fact icon={<Home className="h-4 w-4" />} label="Type de bien">
          {propertyTypeLabel(sale.property_type)}
        </Fact>
        <Fact icon={<Ruler className="h-4 w-4" />} label={`Surface${surfaceKind}`}>
          {primarySurface ? formatSurface(primarySurface) : "Non précisée"}
        </Fact>
        <Fact icon={<LayoutGrid className="h-4 w-4" />} label="Pièces">
          {sale.rooms_count != null ? String(sale.rooms_count) : "Non précisé"}
        </Fact>
        <Fact icon={<BedDouble className="h-4 w-4" />} label="Chambres">
          {sale.bedrooms_count != null ? String(sale.bedrooms_count) : "Non précisé"}
        </Fact>
        {sale.carrez_surface_m2 != null && (
          <Fact icon={<Ruler className="h-4 w-4" />} label="Surface Carrez">
            {formatSurface(sale.carrez_surface_m2)}
          </Fact>
        )}
        {showLand && (
          <Fact icon={<Trees className="h-4 w-4" />} label="Terrain">
            {formatSurface(sale.land_surface_m2)}
          </Fact>
        )}
        {sale.bathrooms_count != null && (
          <Fact icon={<Bath className="h-4 w-4" />} label="Salles de bain">
            {String(sale.bathrooms_count)}
          </Fact>
        )}
        {sale.parking_count != null && (
          <Fact icon={<Car className="h-4 w-4" />} label="Stationnement">
            {String(sale.parking_count)}
          </Fact>
        )}
        <Fact icon={<Banknote className="h-4 w-4" />} label="Mise à prix">
          {formatPrice(sale.starting_price_eur)}
        </Fact>
        <Fact icon={<CalendarClock className="h-4 w-4" />} label="Date de vente">
          {formatDate(sale.sale_date)}
        </Fact>
        {sale.tribunal && (
          <Fact icon={<Landmark className="h-4 w-4" />} label="Tribunal">
            {sale.tribunal}
          </Fact>
        )}
      </dl>

      {/* ── Occupation ───────────────────────────────────────────────────── */}
      <Block icon={<DoorOpen className="h-4 w-4" />} title="Occupation">
        <p className="text-sm leading-relaxed text-foreground">
          {occupancyHeadline(sale.occupancy_status)}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {occupancyExplanation(sale.occupancy_status)}
        </p>
      </Block>

      {/* ── Équipements ──────────────────────────────────────────────────── */}
      <Block icon={<Sparkles className="h-4 w-4" />} title="Équipements repérés">
        {equipments.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {equipments.map((label) => (
              <span key={label} className="chip chip-verified">
                <span aria-hidden className="chip-dot" />
                {label}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Aucun équipement particulier n'a été identifié dans les pièces du dossier.
          </p>
        )}
      </Block>

      {/* ── Points à vérifier (cadre positif : intégrés au plafond) ──────── */}
      {risks.length > 0 && (
        <Block
          icon={<ShieldQuestion className="h-4 w-4" />}
          title="Points à vérifier avant d'enchérir"
        >
          <div className="flex flex-wrap gap-2">
            {risks.slice(0, 6).map((risk, index) => (
              <span key={`${risk.risk_type}-${index}`} className="chip chip-watch">
                <span aria-hidden className="chip-dot" />
                {risk.risk_label || risk.risk_type}
              </span>
            ))}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Chacun de ces points est pris en compte dans le calcul de la mise plafond ci-dessous :
            il s'agit d'éléments à chiffrer ou à confirmer, pas de motifs d'exclusion.
          </p>
        </Block>
      )}

      {/* ── Fiabilité & sources ──────────────────────────────────────────── */}
      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-white/10 pt-4 text-xs text-muted-foreground">
        {surfaceConfidence != null && (
          <span>
            Surface : fiabilité <strong className="text-foreground">{surfaceConfidence}%</strong>
            {surfaceSource ? ` · ${surfaceSource}` : ""}
          </span>
        )}
        {documentCount > 0 && (
          <span>
            <strong className="text-foreground">{documentCount}</strong> document
            {documentCount > 1 ? "s" : ""} officiel{documentCount > 1 ? "s" : ""} au dossier
          </span>
        )}
        {sale.source_name && <span>Source : {sale.source_name}</span>}
      </div>
    </div>
  );
}

function Fact({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-white/8 bg-white/[0.03] p-3">
      <dt className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        <span className="text-gold">{icon}</span>
        {label}
      </dt>
      <dd className="mt-1.5 text-sm font-medium tabular-nums text-foreground">{children}</dd>
    </div>
  );
}

function Block({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="mt-6">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gold">
        {icon}
        {title}
      </div>
      <div className="mt-2.5">{children}</div>
    </div>
  );
}

function occupancyHeadline(status: string | null | undefined): string {
  const normalized = (status ?? "").toLowerCase();
  if (!status || normalized === "unknown" || normalized === "inconnu") {
    return "Statut d'occupation non précisé.";
  }
  return occupancyLabel(status);
}

function occupancyExplanation(status: string | null | undefined): string {
  const normalized = (status ?? "").toLowerCase();
  if (!status || normalized === "unknown" || normalized === "inconnu") {
    return "À confirmer dans le procès-verbal descriptif : un bien libre se prend possession plus vite, un bien occupé demande d'anticiper le délai et le coût de sortie.";
  }
  if (normalized.includes("squat")) {
    return "Occupation sans titre signalée : à confirmer et à intégrer au délai et au budget de reprise.";
  }
  if (normalized.includes("lou") || normalized.includes("rent")) {
    return "Un bail est en cours : loyer, durée et conditions de sortie déterminent l'intérêt du dossier.";
  }
  if (normalized.includes("propri") || normalized.includes("owner")) {
    return "Occupé par le propriétaire : prévoir le délai de libération après l'adjudication.";
  }
  if (normalized.includes("occup")) {
    return "Bien occupé : vérifier le titre d'occupation et le délai de libération avant d'enchérir.";
  }
  return "Bien libre : disponible à la jouissance après la vente, hypothèse la plus simple à valoriser.";
}
