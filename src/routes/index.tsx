import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { getSales, getStats } from "@/lib/queries";
import { formatPrice, formatDate, occupancyLabel } from "@/lib/format";
import type { AuctionSale } from "@/lib/types";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Enchères Immo — Investir dans l'immobilier judiciaire en France" },
      {
        name: "description",
        content:
          "Plateforme premium pour identifier, analyser et investir dans les ventes aux enchères immobilières judiciaires en France. Scoring d'investissement, alertes sur-mesure, données multisources.",
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

  return (
    <main className="bg-background text-foreground">
      {/* HERO */}
      <section className="mx-auto max-w-7xl px-6 pb-32 pt-24 text-center">
        <span className="mb-8 inline-block border border-[var(--gold)]/30 px-3 py-1 text-[10px] uppercase tracking-[0.3em] text-[var(--gold)]">
          L'excellence judiciaire
        </span>
        <h1 className="font-display text-5xl leading-tight md:text-7xl">
          Investissez dans l'immobilier
          <br />
          <span className="text-[var(--gold)]">de haute précision.</span>
        </h1>
        <p className="mx-auto mt-8 max-w-2xl text-lg font-light leading-relaxed text-muted-foreground">
          Accédez aux ventes aux enchères judiciaires avec des données exclusives,
          un scoring d'investissement prédictif et des alertes sur-mesure.
        </p>
        <div className="mt-12 flex flex-col justify-center gap-4 sm:flex-row">
          <Link
            to="/sales"
            className="bg-[var(--gold)] px-10 py-5 text-xs font-bold uppercase tracking-[0.2em] text-[var(--background)] transition-colors hover:bg-[var(--gold-soft)]"
          >
            Explorer les ventes
          </Link>
          <Link
            to="/map"
            className="border border-white/20 px-10 py-5 text-xs font-bold uppercase tracking-[0.2em] text-foreground transition-colors hover:border-white"
          >
            Voir la carte
          </Link>
        </div>
      </section>

      {/* PROOF BANNER */}
      <section className="w-full border-y border-white/10 bg-[var(--surface)]">
        <div className="mx-auto grid max-w-7xl grid-cols-2 gap-8 px-6 py-12 md:grid-cols-4">
          <ProofStat
            value={stats ? `${stats.totalSales.toLocaleString("fr-FR")}+` : "—"}
            label="Annonces actives"
          />
          <ProofStat
            value={stats ? String(stats.departments) : "—"}
            label="Départements"
          />
          <ProofStat value="22%" label="ROI moyen constaté" />
          <ProofStat value="24h" label="Mise à jour flux" />
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="mx-auto max-w-7xl px-6 py-32">
        <div className="mb-20 flex flex-col items-start justify-between gap-8 md:flex-row md:items-end">
          <div className="max-w-xl">
            <h2 className="font-display text-4xl leading-tight">
              Une méthodologie
              <br />
              rigoureuse.
            </h2>
            <p className="mt-6 font-light text-muted-foreground">
              De la détection à l'adjudication, notre plateforme sécurise chaque
              étape de votre acquisition immobilière.
            </p>
          </div>
          <Link
            to="/sales"
            className="border-b border-[var(--gold)] pb-2 text-sm uppercase tracking-[0.2em] text-[var(--gold)]"
          >
            Voir le guide complet
          </Link>
        </div>

        <div className="grid gap-12 md:grid-cols-3">
          <StepCard
            num="01"
            title="Analyse Prédictive"
            desc="Extraction multisource des PV de vente et diagnostics techniques par nos algorithmes."
          />
          <StepCard
            num="02"
            title="Scoring de Rendement"
            desc="Évaluation automatique de la rentabilité locative et du potentiel de plus-value."
          />
          <StepCard
            num="03"
            title="Suivi Stratégique"
            desc="Gestion des visites, mise en relation avocat et alertes en temps réel sur les enchères."
          />
        </div>
      </section>

      {/* FEATURED SALES */}
      <section className="bg-[var(--surface)] px-6 py-32">
        <div className="mx-auto max-w-7xl">
          <div className="mb-16">
            <h2 className="font-display text-3xl">Sélection Premium</h2>
            <div className="mt-4 h-px w-20 bg-[var(--gold)]" />
          </div>

          <div className="grid gap-8 md:grid-cols-3">
            {featured && featured.length > 0
              ? featured.map((sale) => <FeaturedCard key={sale.id} sale={sale} />)
              : Array.from({ length: 3 }).map((_, i) => <FeaturedSkeleton key={i} />)}
          </div>

          <div className="mt-12 text-center">
            <Link
              to="/sales"
              className="inline-flex items-center gap-2 border border-[var(--gold)]/30 px-8 py-4 text-xs font-bold uppercase tracking-[0.2em] text-[var(--gold)] transition-all hover:bg-[var(--gold)] hover:text-[var(--background)]"
            >
              Voir toutes les annonces <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </section>

      {/* TRUST */}
      <section className="mx-auto max-w-7xl border-t border-white/10 px-6 py-24 text-center">
        <p className="mb-12 text-[10px] uppercase tracking-[0.4em] text-muted-foreground">
          Sources officielles &amp; certifiées
        </p>
        <div className="flex flex-wrap items-center justify-center gap-12 opacity-40 grayscale">
          <span className="font-display text-xl font-bold tracking-tight">DGFIP</span>
          <span className="font-display text-xl font-bold tracking-tight">
            Ministère de la Justice
          </span>
          <span className="font-display text-xl font-bold tracking-tight">
            Notaires de France
          </span>
          <span className="font-display text-xl font-bold tracking-tight">Infogreffe</span>
        </div>
      </section>

      {/* FINAL CTA */}
      <section className="bg-[var(--gold)] px-6 py-24">
        <div className="mx-auto max-w-4xl text-center">
          <h2 className="font-display text-4xl leading-tight text-[var(--background)] md:text-5xl">
            Prêt à saisir les meilleures opportunités du marché&nbsp;?
          </h2>
          <p className="mx-auto mt-8 max-w-2xl text-lg text-[var(--background)]/80">
            Créez votre profil investisseur et recevez vos premières alertes
            personnalisées d'ici 5 minutes.
          </p>
          <Link
            to="/alerts"
            className="mt-12 inline-block bg-[var(--background)] px-12 py-5 text-xs font-bold uppercase tracking-[0.2em] text-foreground transition-transform hover:scale-105"
          >
            Commencer l'expérience
          </Link>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="border-t border-white/10 py-12">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-6 px-6 md:flex-row">
          <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            © {new Date().getFullYear()} Enchères Immo — Finance &amp; Immobilier Judiciaire
          </span>
          <div className="flex gap-8 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            <a href="#" className="hover:text-foreground">Légal</a>
            <a href="#" className="hover:text-foreground">Confidentialité</a>
            <a href="#" className="hover:text-foreground">Contact</a>
          </div>
        </div>
      </footer>
    </main>
  );
}

function ProofStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="text-center">
      <div className="font-display text-2xl font-bold text-[var(--gold-soft)]">{value}</div>
      <div className="mt-2 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

function StepCard({ num, title, desc }: { num: string; title: string; desc: string }) {
  return (
    <div className="relative border border-white/5 bg-[var(--surface)]/50 p-8">
      <span className="font-display pointer-events-none absolute -top-4 left-8 text-4xl font-bold italic text-[var(--gold)]/20">
        {num}
      </span>
      <h3 className="mb-4 text-lg font-semibold text-[var(--gold-soft)]">{title}</h3>
      <p className="text-sm leading-relaxed text-muted-foreground">{desc}</p>
    </div>
  );
}

function FeaturedCard({ sale }: { sale: AuctionSale }) {
  const score = sale.investment_score != null ? Number(sale.investment_score) : null;
  const scoreLabel = score != null ? `Score : ${(score / 10).toFixed(1)}/10` : null;
  const location = [sale.postal_code, sale.city].filter(Boolean).join(" ") || sale.department || "France";

  return (
    <Link
      to="/sales/$id"
      params={{ id: sale.id }}
      className="group block border border-white/5 bg-background transition-all hover:border-[var(--gold)]/50"
    >
      <div className="relative h-56 overflow-hidden bg-[var(--surface)]">
        {scoreLabel && (
          <div className="absolute right-4 top-4 z-10 bg-[var(--gold)] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--background)] shadow-xl">
            {scoreLabel}
          </div>
        )}
        <div className="absolute bottom-4 left-4 z-10 bg-black/60 px-3 py-1 text-[10px] uppercase tracking-tight text-white backdrop-blur-md">
          {location}
        </div>
        <div
          className="h-full w-full bg-cover bg-center opacity-70 transition-transform duration-700 group-hover:scale-110"
          style={{
            backgroundImage:
              "linear-gradient(135deg, rgba(201,168,76,0.15), rgba(13,13,13,0.85)), url('https://images.unsplash.com/photo-1560518883-ce09059eeffa?auto=format&fit=crop&q=80&w=800')",
          }}
        />
      </div>
      <div className="p-6">
        <h4 className="mb-4 line-clamp-2 text-base font-medium leading-tight">
          {sale.title || "Bien immobilier"}
        </h4>
        <div className="mb-6 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <div>
            <span className="text-foreground">Mise à prix :</span> {formatPrice(sale.starting_price_eur)}
          </div>
          <div>
            <span className="text-foreground">Vente :</span> {formatDate(sale.sale_date)}
          </div>
          {sale.occupancy_status && (
            <div>
              <span className="text-foreground">Statut :</span> {occupancyLabel(sale.occupancy_status)}
            </div>
          )}
        </div>
        <div className="w-full border border-[var(--gold)]/20 py-3 text-center text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--gold)] transition-all group-hover:bg-[var(--gold)] group-hover:text-[var(--background)]">
          Consulter l'analyse
        </div>
      </div>
    </Link>
  );
}

function FeaturedSkeleton() {
  return (
    <div className="border border-white/5 bg-background">
      <div className="h-56 animate-pulse bg-[var(--surface)]" />
      <div className="space-y-3 p-6">
        <div className="h-4 w-3/4 animate-pulse bg-[var(--surface)]" />
        <div className="h-3 w-1/2 animate-pulse bg-[var(--surface)]" />
        <div className="h-10 w-full animate-pulse bg-[var(--surface)]" />
      </div>
    </div>
  );
}