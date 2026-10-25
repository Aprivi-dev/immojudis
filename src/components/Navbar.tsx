"use client";

import { usePublicPathname } from "@/hooks/use-public-pathname";
import { SiteHeader } from "@/components/SiteHeader";

/**
 * En-tête commun du site. La console d'administration apporte sa propre barre latérale ; le
 * catalogue (/sales) affiche le même en-tête depuis SearchHeader, avec sa barre de recherche au
 * milieu.
 */
export function Navbar() {
  return showsNavbar(usePublicPathname()) ? <SiteHeader /> : null;
}

/**
 * Faux quand la page apporte sa propre barre (administration, catalogue). Partagé avec l'en-tête de
 * secours (`providers.tsx`).
 */
export function showsNavbar(pathname: string): boolean {
  const isAdminArea = pathname === "/admin" || pathname.startsWith("/admin/");
  const isSalesListing = pathname === "/sales" || pathname === "/sales/";
  return !isAdminArea && !isSalesListing;
}
