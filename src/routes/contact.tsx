import { createFileRoute, Link } from "@/lib/router-compat";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.js";
import FileSearch from "lucide-react/dist/esm/icons/file-search.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";

export const Route = createFileRoute("/contact")({
  head: () => ({
    meta: [
      { title: "Contact — Immojudis" },
      {
        name: "description",
        content: "Contacter l'équipe Immojudis.",
      },
    ],
  }),
  component: ContactPage,
});

function ContactPage() {
  return (
    <main className="liquid-page min-h-screen px-4 py-10 text-foreground sm:px-6">
      <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[1fr_24rem] lg:items-stretch">
        <section className="glass-shell rounded-lg p-6 sm:p-8">
          <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
            <ShieldCheck className="h-4 w-4" />
            Support Immojudis
          </div>
          <h1 className="mt-4 font-display text-4xl leading-tight text-foreground sm:text-5xl">
            Une question sur un dossier, une source ou un accès ?
          </h1>
          <p className="mt-5 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
            Pour une question sur une annonce, une source documentaire ou un accès Analyse, préparez
            l'identifiant de la vente concernée afin de faciliter le traitement.
          </p>

          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <div className="liquid-panel-soft rounded-lg p-5">
              <FileSearch className="h-5 w-5 text-gold" />
              <h2 className="mt-4 text-sm font-semibold uppercase tracking-[0.18em] text-foreground">
                Découverte / Analyse
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Centralisez vos biens à suivre depuis les favoris et revenez avec l'identifiant de
                vente si une lecture semble incohérente.
              </p>
              <Link
                to="/sales"
                className="mt-4 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-gold hover:text-gold-soft"
              >
                Parcourir les annonces <ArrowUpRight className="h-4 w-4" />
              </Link>
            </div>
            <div className="liquid-panel-soft rounded-lg p-5">
              <ShieldCheck className="h-5 w-5 text-gold" />
              <h2 className="mt-4 text-sm font-semibold uppercase tracking-[0.18em] text-foreground">
                Professionnel
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Pour préparer une publication, l'espace pro permet déjà de structurer une annonce
                premium et ses pièces.
              </p>
              <Link
                to="/publish"
                className="mt-4 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-gold hover:text-gold-soft"
              >
                Préparer une annonce <ArrowUpRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </section>

        <aside className="glass-shell relative min-h-[28rem] overflow-hidden rounded-lg p-6">
          <div className="cinematic-grid absolute inset-0 opacity-35" />
          <div className="relative z-10">
            <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-gold">
              Signal Immojudis
            </div>
            <p className="mt-4 max-w-xs font-display text-2xl leading-tight text-foreground">
              Un bon support commence par une preuve claire.
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}
