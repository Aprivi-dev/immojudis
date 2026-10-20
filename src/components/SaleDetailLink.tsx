"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { useSaleDetailLink } from "@/components/search/use-sale-detail-link";

/**
 * Lien vers la fiche d'une vente depuis une page qui n'est pas le catalogue (page d'un tribunal,
 * audiences à venir, favoris, comparaisons…). Le HTML rendu par le serveur reste `/sales/<id>` ;
 * l'origine (`?from=`) s'ajoute côté navigateur à l'approche du lien (voir `useSaleDetailLink`),
 * pour que « Retour au tribunal », « Retour aux audiences »… s'affichent sur la fiche sans créer
 * d'adresse supplémentaire pour les robots.
 */
export function SaleDetailLink({
  saleId,
  returnTo,
  onPointerEnter,
  onPointerDown,
  onTouchStart,
  onFocus,
  ...props
}: Omit<ComponentProps<typeof Link>, "href"> & { saleId: string; returnTo: string }) {
  const { href, armProps } = useSaleDetailLink(saleId, returnTo);
  return (
    <Link
      {...props}
      href={href}
      onPointerEnter={(event) => {
        armProps.onPointerEnter();
        onPointerEnter?.(event);
      }}
      onPointerDown={(event) => {
        armProps.onPointerDown();
        onPointerDown?.(event);
      }}
      onTouchStart={(event) => {
        armProps.onTouchStart();
        onTouchStart?.(event);
      }}
      onFocus={(event) => {
        armProps.onFocus();
        onFocus?.(event);
      }}
    />
  );
}
