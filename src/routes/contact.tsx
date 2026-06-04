import { createFileRoute, Link } from "@tanstack/react-router";

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
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="font-display text-4xl text-foreground">Contact</h1>
      <div className="mt-8 space-y-6 text-sm leading-relaxed text-muted-foreground">
        <p>
          Pour une question sur une annonce, une source documentaire ou un accès investisseur,
          préparez l'identifiant de la vente concernée afin de faciliter le traitement.
        </p>
        <div className="rounded-lg border border-border bg-card p-5">
          <h2 className="text-base font-semibold text-foreground">Canal principal</h2>
          <p className="mt-2">
            Utilisez pour le moment l'espace investisseur et les favoris pour centraliser les biens
            à suivre.
          </p>
          <Link
            to="/sales"
            className="mt-4 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
          >
            Parcourir les annonces
          </Link>
        </div>
      </div>
    </main>
  );
}
