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
            Les données de compte servent à personnaliser la veille, les favoris, les rapports, les
            alertes et les mises en relation. Les documents sensibles restent encadrés par les
            règles de sécurité de la plateforme.
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
            <h2 className="text-base font-semibold text-foreground">Rapports et espace Analyse</h2>
            <p className="mt-2">
              Les rapports sauvegardés, simulations de mise maximale, notes privées, suivis
              d'audience, exports et clés API sont rattachés au compte connecté afin de respecter
              les quotas, tracer les usages et isoler les données entre utilisateurs.
            </p>
          </section>
          <section className="liquid-panel-soft rounded-lg p-5">
            <h2 className="text-base font-semibold text-foreground">Alertes email</h2>
            <p className="mt-2">
              Les alertes email ne sont créées qu'après activation explicite. ImmoJudis conserve
              l'état du consentement, sa date d'activation, sa source et, le cas échéant, sa date de
              révocation. Chaque email d'alerte contient un lien de désinscription qui désactive les
              envois email tout en conservant les notifications dans l'application.
            </p>
          </section>
          <section className="liquid-panel-soft rounded-lg p-5">
            <h2 className="text-base font-semibold text-foreground">Mise en relation avocat</h2>
            <p className="mt-2">
              Les demandes de mise en relation conservent la vente concernée, l'email du compte, le
              mode de contact préféré, le message libre et les informations utiles transmises par le
              demandeur. Elles sont utilisées pour orienter la demande vers des avocats référencés
              par ImmoJudis, distincts des contacts indiqués sur les sources d'annonces.
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
            <h2 className="text-base font-semibold text-foreground">Sous-traitants</h2>
            <p className="mt-2">
              L'hébergement applicatif est assuré par Vercel, l'authentification et la base de
              données par Supabase, les paiements par Stripe lorsque le checkout est activé, et les
              emails transactionnels par Resend lorsque les alertes email sont configurées. Les clés
              API complètes ne sont affichées qu'une seule fois et seul leur hash est conservé.
            </p>
          </section>
          <section className="liquid-panel-soft rounded-lg p-5">
            <h2 className="text-base font-semibold text-foreground">Sécurité</h2>
            <p className="mt-2">
              Les accès aux données d'analyse, favoris, alertes, rapports, notes et demandes sont
              limités aux comptes Analyse actifs via les règles de sécurité de la base de données.
              Les accès administrateur sont réservés aux comptes explicitement autorisés.
            </p>
          </section>
          <section className="liquid-panel-soft rounded-lg p-5">
            <h2 className="text-base font-semibold text-foreground">Droits et suppression</h2>
            <p className="mt-2">
              Un utilisateur peut demander l'accès, la rectification ou la suppression de ses
              données personnelles via la page contact. Certaines traces techniques ou comptables
              peuvent être conservées lorsque cela est nécessaire à la sécurité, à la facturation ou
              à la preuve des consentements.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
