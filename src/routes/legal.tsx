import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/legal")({
  head: () => ({
    meta: [
      { title: "Mentions légales — Immojudis" },
      {
        name: "description",
        content: "Mentions légales de la plateforme Immojudis.",
      },
    ],
  }),
  component: LegalPage,
});

function LegalPage() {
  return (
    <main className="liquid-page min-h-screen px-4 py-10 text-foreground sm:px-6">
      <div className="mx-auto max-w-4xl">
        <header className="glass-shell rounded-lg p-6 sm:p-8">
          <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
            Cadre de lecture
          </div>
          <h1 className="mt-4 font-display text-4xl leading-tight text-foreground sm:text-5xl">
            Mentions légales
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Immojudis apporte une aide à la décision, mais la vérification finale reste attachée aux
            pièces officielles et aux professionnels compétents.
          </p>
        </header>

        <div className="mt-6 space-y-4 text-sm leading-relaxed text-muted-foreground">
          <section className="liquid-panel-soft rounded-lg p-5">
            <h2 className="text-base font-semibold text-foreground">Éditeur</h2>
            <p className="mt-2">
              Immojudis est une interface de consultation et d'analyse de ventes aux enchères
              immobilières judiciaires.
            </p>
          </section>
          <section className="liquid-panel-soft rounded-lg p-5">
            <h2 className="text-base font-semibold text-foreground">Sources</h2>
            <p className="mt-2">
              Les informations affichées proviennent de sources publiques ou partenaires et peuvent
              être enrichies automatiquement. Elles doivent être vérifiées auprès des sources
              officielles avant toute décision d'investissement.
            </p>
          </section>
          <section className="liquid-panel-soft rounded-lg p-5">
            <h2 className="text-base font-semibold text-foreground">Responsabilité</h2>
            <p className="mt-2">
              Les scores, estimations et analyses sont fournis comme aide à la lecture. Ils ne
              constituent ni un conseil juridique, ni un conseil financier, ni une garantie de
              rentabilité.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
