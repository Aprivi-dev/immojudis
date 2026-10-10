"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Card, Eyebrow, buttonClasses } from "@/components/ui/primitives";

export default function Error({ error, retry }: { error: Error; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main id="contenu" className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6 sm:py-24">
      <title>Cette page n’a pas chargé</title>
      <Card role="alert" className="text-center sm:!p-10">
        <Eyebrow>Incident temporaire</Eyebrow>
        <h1 className="mt-3 font-display text-4xl font-semibold">Cette page n’a pas chargé</h1>
        <p className="mx-auto mt-3 max-w-md text-ink-soft">
          Une erreur est survenue. Vos données n’ont pas été modifiées : vous pouvez réessayer ou
          revenir à l’accueil.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <button type="button" onClick={retry} className={buttonClasses({ variant: "primary" })}>
            Réessayer
          </button>
          <Link href="/" className={buttonClasses()}>
            Retour à l’accueil
          </Link>
        </div>
      </Card>
    </main>
  );
}
