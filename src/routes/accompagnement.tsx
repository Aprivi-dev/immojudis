import { createFileRoute, Link } from "@/lib/router-compat";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import FileSearch from "lucide-react/dist/esm/icons/file-search.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";

export const Route = createFileRoute("/accompagnement")({
  head: () => ({
    meta: [
      { title: "Accompagnement — Immojudis" },
      {
        name: "description",
        content:
          "Accompagnement Immojudis pour lire une vente judiciaire, préparer son dossier et fixer un prix plafond.",
      },
    ],
  }),
  component: AccompagnementPage,
});

function AccompagnementPage() {
  return (
    <main className="liquid-page min-h-screen px-4 py-10 text-foreground sm:px-6">
      <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[1fr_24rem] lg:items-stretch">
        <section className="glass-shell rounded-lg p-6 sm:p-8">
          <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
            <ShieldCheck className="h-4 w-4" />
            Accompagnement Immojudis
          </div>
          <h1 className="mt-4 max-w-3xl font-display text-4xl leading-tight text-foreground sm:text-5xl">
            Lire un dossier judiciaire avant de lever la main.
          </h1>
          <p className="mt-5 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
            Nous aidons les investisseurs à comprendre les pièces, repérer les risques et préparer
            une limite d'enchère réaliste avant l'audience.
          </p>

          <div className="mt-8 grid gap-4 md:grid-cols-3">
            <SupportCard
              icon={FileSearch}
              title="Lecture"
              text="Annonce, cahier des conditions de vente, occupation, diagnostics et points à vérifier."
            />
            <SupportCard
              icon={Scale}
              title="Décision"
              text="Prix plafond, frais, travaux, marge de sécurité et scénarios de revente ou location."
            />
            <SupportCard
              icon={ShieldCheck}
              title="Préparation"
              text="Questions à poser, pièces à obtenir et éléments à valider avec votre avocat."
            />
          </div>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              to="/sales"
              className="liquid-button inline-flex items-center justify-center gap-2 rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.16em] text-background"
            >
              Voir les annonces <ArrowRight className="h-4 w-4" />
            </Link>
            <Link to="/contact" className="ij-login-button">
              Nous contacter
            </Link>
          </div>
        </section>

        <aside className="glass-shell relative min-h-[28rem] overflow-hidden rounded-lg p-6">
          <img
            src="/media/landing/judicial-candle.png"
            alt=""
            width={1188}
            height={1324}
            loading="lazy"
            className="absolute -bottom-16 left-1/2 h-[26rem] w-auto -translate-x-1/2 opacity-75"
          />
          <div className="relative z-10 max-w-xs">
            <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-gold">
              Prix plafond
            </div>
            <p className="mt-4 font-display text-2xl leading-tight text-foreground">
              La bonne enchère est souvent celle qu'on sait arrêter.
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}

function SupportCard({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof FileSearch;
  title: string;
  text: string;
}) {
  return (
    <div className="liquid-panel-soft rounded-lg p-5">
      <Icon className="h-5 w-5 text-gold" />
      <h2 className="mt-4 text-sm font-semibold uppercase tracking-[0.18em] text-foreground">
        {title}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{text}</p>
    </div>
  );
}
