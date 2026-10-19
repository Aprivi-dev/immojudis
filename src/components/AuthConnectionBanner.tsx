"use client";

import { useAuth } from "@/hooks/use-auth";
import { loginPathWithRedirect } from "@/lib/navigation";
import { Button, buttonClasses } from "@/components/ui/primitives";

/**
 * Bandeau commun quand l'identité du compte n'a pas pu être vérifiée (`/sales`, `/favoris`,
 * `/alertes`, `/compte`, fiche d'une vente). Il n'existe que côté navigateur : `authError` n'est
 * posé qu'après l'hydratation, jamais dans le HTML des pages publiques.
 *
 * - Réseau ou serveur indisponible : « Réessayer » relit la session sans la vider, et
 *   « Se reconnecter » reste proposé.
 * - Session rejetée par le serveur : réessayer ne changerait rien, seule la reconnexion est proposée.
 */
export function AuthConnectionBanner({
  loginHref,
  className = "",
}: {
  /** Adresse de connexion ; par défaut, un retour sur la page courante. */
  loginHref?: string;
  className?: string;
}) {
  const { authError, authErrorKind, loading, retry } = useAuth();
  if (loading || !authError) return null;
  const expired = authErrorKind === "expired";
  const href =
    loginHref ??
    loginPathWithRedirect(
      typeof window === "undefined" ? null : `${window.location.pathname}${window.location.search}`,
      { mode: "login" },
    );
  return (
    <div
      role="alert"
      data-testid="auth-connection-banner"
      className={`mx-auto flex max-w-[1260px] flex-wrap items-center gap-3 rounded-lg border border-amber-700/30 bg-amber-50 px-4 py-3 text-sm text-amber-900 ${className}`}
    >
      <p className="font-medium">
        {expired
          ? "Votre session a expiré. Reconnectez-vous pour continuer."
          : "Nous n’avons pas pu vérifier votre connexion."}
      </p>
      {expired ? null : (
        <Button variant="secondary" onClick={() => retry?.()}>
          Réessayer
        </Button>
      )}
      <a href={href} className={buttonClasses({ variant: expired ? "dark" : "secondary" })}>
        Se reconnecter
      </a>
    </div>
  );
}
