import type { ReactNode } from "react";
import { AuthGate } from "@/components/AuthGate";

/**
 * Une seule barrière d’accès (connexion, rôle administrateur, double authentification) pour toute
 * l’arborescence /admin. Le layout persiste d’une vue à l’autre : le contrôle du niveau
 * d’assurance TOTP n’est donc plus refait, ni l’écran vidé, à chaque changement de page.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AuthGate>{children}</AuthGate>;
}
