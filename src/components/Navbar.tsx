"use client";

import { usePublicPathname } from "@/hooks/use-public-pathname";
import { SiteHeader } from "@/components/SiteHeader";

/**
 * En-tête commun du site : un seul composant, deux thèmes (sombre pour
 * l'accueil, clair ailleurs). La console d'administration apporte sa propre
 * barre latérale ; le catalogue (/sales) affiche le même en-tête depuis
 * SearchHeader, avec sa barre de recherche au milieu.
 */
export function Navbar() {
  const pathname = usePublicPathname();
  const isAdminArea = pathname === "/admin" || pathname.startsWith("/admin/");
  const isSalesListing = pathname === "/sales" || pathname === "/sales/";

  if (isAdminArea || isSalesListing) return null;

  return <SiteHeader theme={pathname === "/" ? "dark" : "light"} />;
}
