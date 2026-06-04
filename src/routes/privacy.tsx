import { createFileRoute } from "@tanstack/react-router";

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
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="font-display text-4xl text-foreground">Confidentialité</h1>
      <div className="mt-8 space-y-6 text-sm leading-relaxed text-muted-foreground">
        <section>
          <h2 className="text-base font-semibold text-foreground">Données de compte</h2>
          <p className="mt-2">
            Les comptes, favoris et alertes sont gérés via Supabase. Les données associées servent
            uniquement à fournir les fonctionnalités de suivi et de personnalisation.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-foreground">Données locales</h2>
          <p className="mt-2">
            Certaines préférences d'usage, comme les annonces déjà consultées ou les paramètres de
            simulation, peuvent être conservées dans le navigateur.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-foreground">Sécurité</h2>
          <p className="mt-2">
            Les accès aux favoris et alertes sont limités à l'utilisateur connecté via les règles de
            sécurité de la base de données.
          </p>
        </section>
      </div>
    </main>
  );
}
