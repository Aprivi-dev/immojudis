"use client";

import { usePathname } from "next/navigation";
import { publicPathname } from "@/lib/sales-isr";

/**
 * Chemin de l'adresse que voit la personne. À employer à la place de `usePathname` dans tout
 * composant rendu sur `/sales` : sur la variante statique réécrite par le proxy, Next.js rend
 * `usePathname()` côté serveur avec `/sales/defaut`, et le navigateur avec `/sales` (erreur
 * d'hydratation, liens faux). Voir `src/lib/sales-isr.ts`.
 */
export function usePublicPathname(): string {
  return publicPathname(usePathname());
}
