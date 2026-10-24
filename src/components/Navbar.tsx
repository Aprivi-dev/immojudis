"use client";

import { usePublicPathname } from "@/hooks/use-public-pathname";
import { SiteHeader, type SiteHeaderTheme } from "@/components/SiteHeader";

/**
 * En-tête commun du site, clair partout depuis que l'accueil n'a plus de photo
 * en plein écran (24/10/2026). La console d'administration apporte sa propre
 * barre latérale ; le catalogue (/sales) affiche le même en-tête depuis
 * SearchHeader, avec sa barre de recherche au milieu.
 */
export function Navbar() {
  const theme = navbarTheme(usePublicPathname());
  return theme ? <SiteHeader theme={theme} /> : null;
}

/**
 * Thème de l'en-tête commun pour une adresse, ou `null` quand la page apporte sa propre barre
 * (administration, catalogue). Partagé avec l'en-tête de secours (`providers.tsx`).
 */
export function navbarTheme(pathname: string): SiteHeaderTheme | null {
  const isAdminArea = pathname === "/admin" || pathname.startsWith("/admin/");
  const isSalesListing = pathname === "/sales" || pathname === "/sales/";
  if (isAdminArea || isSalesListing) return null;
  return "light";
}
