import Link from "next/link";
import { BrandMark } from "@/components/BrandLogo";

export default function NotFound() {
  return (
    <main className="liquid-page flex min-h-screen items-center justify-center px-4 py-10">
      <section className="glass-shell max-w-xl overflow-hidden rounded-lg p-6 text-center sm:p-8">
        <BrandMark className="mx-auto h-16 w-16 drop-shadow-[0_18px_34px_rgba(0,0,0,0.35)]" />
        <h1 className="mt-5 font-display text-6xl leading-none text-gold-soft">404</h1>
        <h2 className="mt-4 font-display text-2xl text-foreground">Page introuvable</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          La page demandee n'existe pas ou a ete deplacee.
        </p>
        <div className="mt-6">
          <Link
            href="/"
            className="liquid-button inline-flex items-center justify-center rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.18em] text-background transition hover:brightness-105"
          >
            Retour a l'accueil
          </Link>
        </div>
      </section>
    </main>
  );
}
