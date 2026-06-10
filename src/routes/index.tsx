import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.js";
import Calculator from "lucide-react/dist/esm/icons/calculator.js";
import FileSearch from "lucide-react/dist/esm/icons/file-search.js";
import Gavel from "lucide-react/dist/esm/icons/gavel.js";
import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import ScanSearch from "lucide-react/dist/esm/icons/scan-search.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { getStats } from "@/lib/queries";
import { formatDate } from "@/lib/format";
import { useAuth } from "@/hooks/use-auth";
import { isProfessionalAccount } from "@/lib/account";

const PROOF_POINTS = [
  {
    icon: FileSearch,
    label: "Source",
    value: "preuve utile",
  },
  {
    icon: ShieldCheck,
    label: "Risque",
    value: "contexte réel",
  },
  {
    icon: Calculator,
    label: "Plafond",
    value: "prix limite",
  },
] as const;

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Immojudis — Décider avant d'enchérir" },
      {
        name: "description",
        content:
          "Immojudis transforme les annonces, documents et données de marché des ventes judiciaires en décision claire avant enchère.",
      },
    ],
  }),
  component: HomePage,
});

function HomePage() {
  const { user } = useAuth();
  const { data: stats } = useQuery({
    queryKey: ["stats"],
    queryFn: getStats,
    staleTime: 5 * 60_000,
  });

  const professionalCta = isProfessionalAccount(user)
    ? { to: "/publish", label: "Publier" }
    : user
      ? { to: "/contact", label: "Accès pro" }
      : { to: "/login", label: "Accès pro" };

  return (
    <main className="home-finary min-h-screen text-foreground">
      <section className="home-finary-hero px-4 pb-12 pt-8 sm:px-6 lg:pb-16">
        <div className="mx-auto grid min-h-[calc(100svh-6rem)] max-w-7xl gap-10 lg:grid-cols-[minmax(0,0.86fr)_minmax(34rem,1fr)] lg:items-center">
          <div className="home-finary-copy">
            <div className="home-finary-badge">
              <Landmark className="h-4 w-4" />
              Ventes judiciaires augmentées
            </div>

            <h1 className="home-finary-title">
              Analyser.
              <span>Décider.</span>
              Enchérir.
            </h1>

            <p className="home-finary-lead">
              Immojudis transforme les annonces, pièces et données de marché en une décision claire
              avant la salle de vente.
            </p>

            <div className="home-finary-actions">
              <Link to="/sales" className="home-finary-primary">
                Commencer l'analyse <ArrowUpRight className="h-4 w-4" />
              </Link>
              <Link to={professionalCta.to} className="home-finary-secondary">
                {professionalCta.label}
              </Link>
            </div>

            <div className="home-finary-stats" aria-label="Indicateurs Immojudis">
              <MinimalStat
                label="Annonces analysées"
                value={stats ? `${stats.totalSales.toLocaleString("fr-FR")}+` : "--"}
              />
              <MinimalStat
                label="Départements suivis"
                value={stats ? String(stats.departments) : "--"}
              />
              <MinimalStat
                label="Prochaine vente"
                value={stats?.nextSale ? formatDate(stats.nextSale) : "--"}
              />
            </div>
          </div>

          <HeroScene />
        </div>
      </section>

      <section className="home-finary-proof px-4 pb-14 sm:px-6">
        <div className="home-proof-flow mx-auto max-w-7xl">
          <div className="home-proof-flow-copy">
            <span>La méthode</span>
            <strong>Source. Risque. Prix limite.</strong>
          </div>
          <div className="home-proof-rail" aria-label="Méthode Immojudis">
            {PROOF_POINTS.map(({ icon: Icon, label, value }) => (
              <div key={label} className="home-proof-node">
                <Icon className="h-4 w-4" />
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <div className="home-proof-output">
            <span>Décision</span>
            <strong>enchérir ou passer</strong>
          </div>
        </div>
      </section>

      <footer className="home-finary-footer px-4 py-8 sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 text-xs uppercase tracking-[0.18em] text-muted-foreground sm:flex-row">
          <span>© {new Date().getFullYear()} Immojudis</span>
          <div className="flex gap-5">
            <Link to="/legal">Légal</Link>
            <Link to="/privacy">Confidentialité</Link>
            <Link to="/contact">Contact</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}

function HeroScene() {
  return (
    <aside className="home-product-visual" aria-label="Aperçu produit Immojudis">
      <div className="home-product-glow" aria-hidden />
      <div className="home-dashboard">
        <div className="home-dashboard-top">
          <span>Immojudis</span>
          <strong>Score 82</strong>
        </div>
        <div className="home-dashboard-value">
          <span>Prix plafond</span>
          <strong>129 400 €</strong>
        </div>
        <div className="home-dashboard-chart" aria-hidden>
          <span />
        </div>
        <div className="home-dashboard-grid">
          <MiniInsight icon={FileSearch} label="Source" value="Cahier de vente" />
          <MiniInsight icon={ScanSearch} label="Risque" value="Travaux à cadrer" />
          <MiniInsight icon={Gavel} label="Action" value="Relire avant audience" />
        </div>
      </div>

      <div className="home-phone-card">
        <span>Décision</span>
        <strong>Intéressant</strong>
        <small>2 points à vérifier</small>
        <div />
      </div>

      <img
        src="/brand/immojudis-sentinel-v2.png"
        alt="Sentinelle Immojudis"
        className="home-sentinel"
      />
    </aside>
  );
}

function MiniInsight({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof FileSearch;
  label: string;
  value: string;
}) {
  return (
    <div>
      <Icon className="h-4 w-4" />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function MinimalStat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
