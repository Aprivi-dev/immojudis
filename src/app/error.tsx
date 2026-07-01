"use client";

import Link from "next/link";
import { BrandMark } from "@/components/BrandLogo";

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);

  return (
    <main className="liquid-page flex min-h-screen items-center justify-center px-4 py-10">
      <section className="glass-shell max-w-xl rounded-lg p-6 text-center sm:p-8">
        <BrandMark className="mx-auto h-14 w-14" />
        <h1 className="mt-5 font-display text-2xl tracking-tight text-foreground">
          Cette page n'a pas charge
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Une erreur est survenue. Vous pouvez reessayer ou revenir a l'accueil.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="liquid-button inline-flex items-center justify-center rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.16em] text-background transition hover:brightness-105"
          >
            Reessayer
          </button>
          <Link
            href="/"
            className="liquid-panel-soft inline-flex items-center justify-center rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.16em] text-gold transition hover:border-gold"
          >
            Retour a l'accueil
          </Link>
        </div>
      </section>
    </main>
  );
}
