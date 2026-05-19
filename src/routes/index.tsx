import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Search, Map as MapIcon, Bell, TrendingUp } from "lucide-react";
import { getStats } from "@/lib/queries";
import { formatDate } from "@/lib/format";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Enchères Immo — Ventes aux enchères immobilières en France" },
      { name: "description", content: "Trouvez et analysez les ventes aux enchères immobilières judiciaires en France. Annonces multisources, scoring d'investissement, alertes personnalisées." },
    ],
  }),
  component: HomePage,
});

function HomePage() {
  const [stats, setStats] = useState<{ totalSales: number; departments: number; nextSale: string | null } | null>(null);
  useEffect(() => {
    getStats().then(setStats).catch(() => setStats(null));
  }, []);

  return (
    <main>
      <section className="border-b border-border bg-gradient-to-b from-secondary/30 to-background">
        <div className="mx-auto max-w-5xl px-4 py-20 text-center">
          <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
            Trouvez et analysez les ventes aux enchères immobilières en France
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground">
            Annonces judiciaires multisources, scoring d'investissement, alertes personnalisées.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link to="/sales" className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90">
              <Search className="h-4 w-4" /> Voir les annonces
            </Link>
            <Link to="/map" className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-6 py-3 text-sm font-medium hover:bg-accent">
              <MapIcon className="h-4 w-4" /> Carte
            </Link>
          </div>
        </div>
      </section>

      {stats && (
        <section className="mx-auto max-w-5xl px-4 py-12">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Stat icon={<Search className="h-5 w-5" />} value={String(stats.totalSales)} label="Annonces actives" />
            <Stat icon={<MapIcon className="h-5 w-5" />} value={String(stats.departments)} label="Départements couverts" />
            <Stat icon={<TrendingUp className="h-5 w-5" />} value={stats.nextSale ? formatDate(stats.nextSale) : "—"} label="Prochaine vente" />
          </div>
        </section>
      )}

      <section className="mx-auto max-w-5xl px-4 pb-20">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Feature icon={<Search />} title="Liste filtrable" desc="Département, ville, prix, surface, occupation, score." />
          <Feature icon={<MapIcon />} title="Carte interactive" desc="Visualisez toutes les ventes géolocalisées." />
          <Feature icon={<Bell />} title="Alertes" desc="Soyez notifié des annonces qui correspondent à vos critères." />
        </div>
      </section>
    </main>
  );
}

function Stat({ icon, value, label }: { icon: React.ReactNode; value: string; label: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-6 text-center">
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-primary">{icon}</div>
      <div className="mt-3 text-2xl font-bold tabular-nums text-foreground">{value}</div>
      <div className="mt-1 text-sm text-muted-foreground">{label}</div>
    </div>
  );
}

function Feature({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="rounded-lg border border-border p-5">
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">{icon}</div>
      <h3 className="mt-3 font-semibold text-foreground">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{desc}</p>
    </div>
  );
}