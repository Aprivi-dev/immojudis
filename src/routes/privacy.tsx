import { createFileRoute } from "@/lib/router-compat";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Confidentialité — Immojudis" },
      {
        name: "description",
        content: "Politique de confidentialité de la plateforme Immojudis.",
      },
    ],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <main className="liquid-page min-h-screen px-4 py-10 text-foreground sm:px-6">
      <div className="mx-auto max-w-4xl">
        <header className="glass-shell rounded-lg p-6 sm:p-8">
          <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
            Données et confiance
          </div>
          <h1 className="mt-4 font-display text-4xl leading-tight text-foreground sm:text-5xl">
            Confidentialité
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Les données de compte servent à personnaliser la veille, les favoris et les alertes. Les
            documents sensibles restent encadrés par les règles de sécurité de la plateforme.
          </p>
        </header>

        <div className="mt-6 space-y-4 text-sm leading-relaxed text-muted-foreground">
          <section className="liquid-panel-soft rounded-lg p-5">
            <h2 className="text-base font-semibold text-foreground">Données de compte</h2>
            <p className="mt-2">
              Les comptes, favoris et alertes sont gérés via Supabase. Les données associées servent
              uniquement à fournir les fonctionnalités de suivi et de personnalisation.
            </p>
          </section>
          <section className="liquid-panel-soft rounded-lg p-5">
            <h2 className="text-base font-semibold text-foreground">Données locales</h2>
            <p className="mt-2">
              Certaines préférences d'usage, comme les annonces déjà consultées ou les paramètres de
              simulation, peuvent être conservées dans le navigateur.
            </p>
          </section>
          <section className="liquid-panel-soft rounded-lg p-5">
            <h2 className="text-base font-semibold text-foreground">Sécurité</h2>
            <p className="mt-2">
              Les accès aux favoris et alertes sont limités à l'utilisateur connecté via les règles
              de sécurité de la base de données.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
