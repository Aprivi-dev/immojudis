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
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="font-display text-4xl text-foreground">Mentions légales</h1>
      <div className="mt-8 space-y-6 text-sm leading-relaxed text-muted-foreground">
        <section>
          <h2 className="text-base font-semibold text-foreground">Éditeur</h2>
          <p className="mt-2">
            Immojudis est une interface de consultation et d'analyse de ventes aux enchères
            immobilières judiciaires.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-foreground">Sources</h2>
          <p className="mt-2">
            Les informations affichées proviennent de sources publiques ou partenaires et peuvent
            être enrichies automatiquement. Elles doivent être vérifiées auprès des sources
            officielles avant toute décision d'investissement.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-foreground">Responsabilité</h2>
          <p className="mt-2">
            Les scores, estimations et analyses sont fournis comme aide à la lecture. Ils ne
            constituent ni un conseil juridique, ni un conseil financier, ni une garantie de
            rentabilité.
          </p>
        </section>
      </div>
    </main>
  );
}
