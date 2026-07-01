import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-screen bg-[#f7f5f1] px-4 py-16 text-foreground sm:px-6">
      <section className="mx-auto max-w-2xl rounded-md border border-border bg-white p-8 text-center shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-soft">
          Fiche indisponible
        </p>
        <h1 className="mt-3 font-display text-4xl">Bien introuvable</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Cette fiche n'existe pas dans les donnees locales ou n'est plus disponible.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            href="/properties"
            className="inline-flex min-h-10 items-center justify-center rounded-md bg-gold-soft px-4 text-sm font-semibold text-white hover:bg-gold"
          >
            Voir la demo
          </Link>
          <Link
            href="/sales"
            className="inline-flex min-h-10 items-center justify-center rounded-md border border-border bg-white px-4 text-sm font-semibold text-foreground hover:border-gold/50"
          >
            Retour aux ventes
          </Link>
        </div>
      </section>
    </main>
  );
}
