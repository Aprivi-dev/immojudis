"use client";

import NextLink from "next/link";
import type { ComponentProps } from "react";

/*
 * Vestige du shim TanStack Router (P6-01). Il ne sert plus qu'aux trois documents juridiques
 * (src/routes/legal.tsx, privacy.tsx, conditions-generales.tsx) : leur code source est ancré par
 * une empreinte SHA-256 (src/lib/legal-documents.ts, vérifiée par compliance-phase-6.test.ts) et
 * toute modification, même sans effet sur le texte rendu, exige de ré-ancrer cette empreinte.
 * Dès que ce ré-ancrage est validé, ces trois fichiers passent à next/link, ce module et
 * src/routes/ sont supprimés (voir docs/audits/2026-10-09-plan-correctif.md, P6-01).
 *
 * Ne l'importez dans aucun autre fichier : utilisez next/link et next/navigation.
 */

/** Équivalent minimal : les options de route sont ignorées, les métadonnées vivent dans src/app. */
export function createFileRoute(_path: string) {
  return <TOptions extends object>(options: TOptions) => options;
}

type LinkProps = Omit<ComponentProps<typeof NextLink>, "href"> & { to: string };

export function Link({ to, ...props }: LinkProps) {
  return <NextLink href={to} {...props} />;
}
