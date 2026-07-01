import { Link } from "@/lib/router-compat";
import Home from "lucide-react/dist/esm/icons/home.js";

export function PropertyNotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f7f5f1] px-4 py-16">
      <section className="max-w-xl rounded-md border border-border bg-white p-8 text-center shadow-sm">
        <span className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-full border border-border bg-muted text-gold-soft">
          <Home className="h-7 w-7" />
        </span>
        <h1 className="mt-5 font-display text-4xl text-foreground">Bien introuvable</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Cette fiche n'existe pas dans les fixtures locales ou n'est pas encore disponible dans la
          base.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            to="/properties/$id"
            params={{ id: "appartement-premium-bordeaux-centre" }}
            className="inline-flex min-h-10 cursor-pointer items-center justify-center rounded-md bg-foreground px-4 text-sm font-semibold text-white transition-colors hover:bg-gold-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
          >
            Voir la fiche demo
          </Link>
          <Link
            to="/sales"
            className="inline-flex min-h-10 cursor-pointer items-center justify-center rounded-md border border-border bg-white px-4 text-sm font-semibold text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
          >
            Retour aux biens
          </Link>
        </div>
      </section>
    </main>
  );
}
