import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.js";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import FileSearch from "lucide-react/dist/esm/icons/file-search.js";
import Gavel from "lucide-react/dist/esm/icons/gavel.js";
import Map from "lucide-react/dist/esm/icons/map.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.js";
import TrendingUp from "lucide-react/dist/esm/icons/trending-up.js";
import { getSales, getStats } from "@/lib/queries";
import {
  formatDate,
  formatPrice,
  formatSurface,
  occupancyLabel,
  propertyTypeLabel,
} from "@/lib/format";
import type { AuctionSale } from "@/lib/types";
import { SourceImage } from "@/components/SourceImage";
import { ScoreBadge } from "@/components/ScoreBadge";

const QUICK_LINKS = [
  {
    to: "/sales",
    icon: FileSearch,
    label: "Choisir les dossiers",
    desc: "Repérer vite ceux qui méritent une vraie analyse.",
  },
  {
    to: "/map",
    icon: Map,
    label: "Explorer la carte",
    desc: "Repérer les opportunités par zone.",
  },
  {
    to: "/sales/new",
    icon: Sparkles,
    label: "Voir les nouveautés",
    desc: "Derniers dossiers ajoutés au flux.",
  },
  {
    to: "/alerts",
    icon: Bell,
    label: "Créer une alerte",
    desc: "Suivre vos critères d'investissement.",
  },
] as const;

const METHOD_STEPS = [
  {
    icon: FileSearch,
    title: "Dossier qualifié",
    desc: "Annonce, PV, cahier de vente et diagnostics sont séparés pour savoir ce qui est prouvé.",
  },
  {
    icon: ShieldCheck,
    title: "Lecture actionnable",
    desc: "Chaque vigilance utile explique son origine, son impact et la vérification à faire.",
  },
  {
    icon: TrendingUp,
    title: "Prix à ne pas dépasser",
    desc: "Le score priorise, puis le seuil d'enchère compare le coût complet au marché local.",
  },
] as const;

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Immojudis — Ventes immobilières judiciaires" },
      {
        name: "description",
        content:
          "Immojudis aide les investisseurs à repérer, comprendre et suivre les ventes aux enchères immobilières judiciaires avec scoring, preuves et alertes.",
      },
    ],
  }),
  component: HomePage,
});

function HomePage() {
  const { data: stats } = useQuery({
    queryKey: ["stats"],
    queryFn: getStats,
    staleTime: 5 * 60_000,
  });

  const { data: featured } = useQuery({
    queryKey: ["sales", "featured-home"],
    queryFn: () => getSales({}, 3, "score_desc"),
    staleTime: 5 * 60_000,
  });

  const leadSale = featured?.[0] ?? null;

  return (
    <main className="liquid-page min-h-screen text-foreground">
      <section className="border-b border-white/10 px-4 py-10 sm:px-6 sm:py-14 lg:py-16">
        <div className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-[1fr_27rem] lg:items-stretch">
          <div className="liquid-hero rounded-lg p-6 sm:p-8 lg:p-10">
            <div className="flex flex-wrap items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.28em] text-gold-soft">
              <span className="h-px w-8 bg-gold" />
              Ventes judiciaires analysées
            </div>

            <h1 className="mt-6 max-w-4xl font-display text-4xl leading-[1.05] text-foreground sm:text-5xl lg:text-6xl">
              Savoir en quelques minutes si une enchère immobilière vaut le coup.
            </h1>

            <p className="mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
              Immojudis transforme les annonces, pièces et diagnostics en une décision lisible :
              intérêt du dossier, risques sourcés, preuves à relire et prix maximum à ne pas dépasser.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                to="/sales"
                className="liquid-button inline-flex items-center justify-center gap-2 rounded-lg px-6 py-3 text-xs font-bold uppercase tracking-[0.18em] text-background transition hover:brightness-105"
              >
                Trouver un dossier <ArrowUpRight className="h-4 w-4" />
              </Link>
              <Link
                to="/map"
                className="liquid-panel-soft inline-flex items-center justify-center gap-2 rounded-lg px-6 py-3 text-xs font-bold uppercase tracking-[0.18em] text-gold transition hover:border-gold hover:text-gold-soft"
              >
                Ouvrir la carte <Map className="h-4 w-4" />
              </Link>
            </div>

            <div className="mt-10 grid gap-3 sm:grid-cols-3">
              <LiveStat
                label="Annonces"
                value={stats ? `${stats.totalSales.toLocaleString("fr-FR")}+` : "—"}
              />
              <LiveStat label="Départements" value={stats ? String(stats.departments) : "—"} />
              <LiveStat
                label="Prochaine vente"
                value={stats?.nextSale ? formatDate(stats.nextSale) : "—"}
              />
            </div>
          </div>

          <LeadOpportunity sale={leadSale} />
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {QUICK_LINKS.map(({ to, icon: Icon, label, desc }) => (
            <Link key={to} to={to} className="liquid-panel-soft group rounded-lg p-5">
              <div className="flex items-start justify-between gap-4">
                <Icon className="h-5 w-5 text-gold" />
                <ArrowUpRight className="h-4 w-4 text-muted-foreground transition group-hover:text-gold" />
              </div>
              <h2 className="mt-5 text-sm font-semibold uppercase tracking-[0.18em] text-foreground">
                {label}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{desc}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[0.8fr_1.2fr] lg:py-12">
        <div>
          <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
            <Gavel className="h-4 w-4" />
            Méthode
          </div>
          <h2 className="mt-4 font-display text-3xl leading-tight text-foreground sm:text-4xl">
            Une lecture premium, mais faite pour décider vite.
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            L'objectif n'est pas d'empiler des informations. C'est de séparer ce qui est prouvé, ce
            qui reste fragile, puis de ramener la décision à une question simple : à quel prix ne
            plus enchérir ?
          </p>
        </div>

        <div className="grid gap-3">
          {METHOD_STEPS.map(({ icon: Icon, title, desc }) => (
            <div key={title} className="liquid-panel-soft rounded-lg p-5">
              <div className="flex items-start gap-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-gold/20 bg-gold/10 text-gold">
                  <Icon className="h-5 w-5" />
                </span>
                <div>
                  <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-foreground">
                    {title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{desc}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
              Opportunités
            </div>
            <h2 className="mt-3 font-display text-3xl text-foreground">À regarder en priorité</h2>
          </div>
          <Link
            to="/sales"
            className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-gold hover:text-gold-soft"
          >
            Toutes les annonces <ArrowUpRight className="h-4 w-4" />
          </Link>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {featured && featured.length > 0
            ? featured.map((sale) => <FeaturedCard key={sale.id} sale={sale} />)
            : Array.from({ length: 3 }).map((_, i) => <FeaturedSkeleton key={i} />)}
        </div>
      </section>

      <section className="border-t border-white/10 px-4 py-12 sm:px-6">
        <div className="liquid-hero mx-auto flex max-w-7xl flex-col gap-6 rounded-lg p-6 sm:p-8 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
              Suivi investisseur
            </div>
            <h2 className="mt-3 font-display text-3xl leading-tight text-foreground">
              Ne laissez pas passer un dossier dans votre zone.
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              Créez des alertes par département, budget, surface ou score minimal pour suivre les
              ventes qui correspondent à votre stratégie.
            </p>
          </div>
          <Link
            to="/alerts"
            className="liquid-button inline-flex shrink-0 items-center justify-center gap-2 rounded-lg px-6 py-3 text-xs font-bold uppercase tracking-[0.18em] text-background transition hover:brightness-105"
          >
            Configurer une alerte <Bell className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <footer className="border-t border-white/10 py-10">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-5 px-4 text-xs uppercase tracking-[0.18em] text-muted-foreground sm:px-6 md:flex-row">
          <span>© {new Date().getFullYear()} Immojudis</span>
          <div className="flex gap-6">
            <Link to="/legal" className="hover:text-foreground">
              Légal
            </Link>
            <Link to="/privacy" className="hover:text-foreground">
              Confidentialité
            </Link>
            <Link to="/contact" className="hover:text-foreground">
              Contact
            </Link>
          </div>
        </div>
      </footer>
    </main>
  );
}

function LiveStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="liquid-panel-soft rounded-lg p-4">
      <div className="font-display text-2xl tabular-nums text-gold-soft">{value}</div>
      <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

function LeadOpportunity({ sale }: { sale: AuctionSale | null }) {
  if (!sale) {
    return (
      <div className="liquid-panel rounded-lg p-5">
        <div className="h-64 animate-pulse rounded-md bg-white/10" />
        <div className="mt-5 h-4 w-2/3 animate-pulse rounded bg-white/10" />
        <div className="mt-3 h-3 w-1/2 animate-pulse rounded bg-white/10" />
      </div>
    );
  }

  return (
    <Link to="/sales/$id" params={{ id: sale.id }} className="liquid-panel group rounded-lg p-4">
      <div className="relative h-64 overflow-hidden rounded-md border border-white/10 bg-surface">
        {sale.source_url ? (
          <SourceImage
            sourceUrl={sale.source_url}
            alt={sale.title ?? "Annonce sélectionnée"}
            className="h-full w-full opacity-90 transition-transform duration-700 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-white/[0.04]">
            <Gavel className="h-10 w-10 text-gold" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-background/80 via-background/25 to-transparent" />
        <div className="absolute left-4 top-4">
          <ScoreBadge score={sale.investment_score} confidence={sale.score_confidence} />
        </div>
        <div className="absolute bottom-4 left-4 right-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-gold-soft">
            Sélection du moment
          </div>
          <h2 className="mt-2 line-clamp-2 text-xl font-semibold leading-tight text-foreground">
            {sale.title ?? propertyTypeLabel(sale.property_type)}
          </h2>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 pt-4 text-sm">
        <MiniMeta label="Mise à prix" value={formatPrice(sale.starting_price_eur)} />
        <MiniMeta label="Vente" value={formatDate(sale.sale_date)} />
      </div>
    </Link>
  );
}

function FeaturedCard({ sale }: { sale: AuctionSale }) {
  const location =
    [sale.postal_code, sale.city].filter(Boolean).join(" ") || sale.department || "France";
  const surface = sale.app_surface_m2 ?? sale.habitable_surface_m2 ?? sale.carrez_surface_m2;

  return (
    <Link
      to="/sales/$id"
      params={{ id: sale.id }}
      className="liquid-panel-soft group rounded-lg p-3"
    >
      <div className="relative h-44 overflow-hidden rounded-md border border-white/10 bg-surface">
        {sale.source_url ? (
          <SourceImage
            sourceUrl={sale.source_url}
            alt={sale.title ?? "Illustration de l'annonce"}
            className="h-full w-full opacity-85 transition-transform duration-700 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-white/[0.04]">
            <Gavel className="h-8 w-8 text-gold" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-background/85 via-background/20 to-transparent" />
        <div className="absolute left-3 top-3">
          <ScoreBadge score={sale.investment_score} confidence={sale.score_confidence} />
        </div>
        <div className="absolute bottom-3 left-3 right-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-gold-soft">
          {location}
        </div>
      </div>
      <div className="p-2 pt-4">
        <h3 className="line-clamp-2 min-h-[2.5rem] text-sm font-semibold leading-snug text-foreground">
          {sale.title || propertyTypeLabel(sale.property_type)}
        </h3>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <MiniMeta label="Prix" value={formatPrice(sale.starting_price_eur)} />
          <MiniMeta label="Surface" value={formatSurface(surface)} />
          <MiniMeta label="Date" value={formatDate(sale.sale_date)} />
          <MiniMeta label="Statut" value={occupancyLabel(sale.occupancy_status)} />
        </div>
      </div>
    </Link>
  );
}

function MiniMeta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 truncate text-sm font-medium text-foreground">{value}</div>
    </div>
  );
}

function FeaturedSkeleton() {
  return (
    <div className="liquid-panel-soft rounded-lg p-3">
      <div className="h-44 animate-pulse rounded-md bg-white/10" />
      <div className="space-y-3 p-2 pt-4">
        <div className="h-4 w-3/4 animate-pulse rounded bg-white/10" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-white/10" />
      </div>
    </div>
  );
}
