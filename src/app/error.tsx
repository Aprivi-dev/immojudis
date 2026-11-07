"use client";

import Link from "next/link";
import { useEffect } from "react";
import { StatusPage } from "@/components/StatusPage";
import { buttonClasses } from "@/components/ui/primitives";

export default function Error({ error, retry }: { error: Error; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <>
      <title>Cette page n’a pas chargé</title>
      <StatusPage
        role="alert"
        eyebrow="Incident temporaire"
        title="Cette page n’a pas chargé"
        description="Une erreur est survenue. Vos données n’ont pas été modifiées : vous pouvez réessayer ou revenir à l’accueil."
        actions={
          <>
            <button type="button" onClick={retry} className={buttonClasses({ variant: "primary" })}>
              Réessayer
            </button>
            <Link href="/" className={buttonClasses()}>
              Retour à l’accueil
            </Link>
          </>
        }
      />
    </>
  );
}
