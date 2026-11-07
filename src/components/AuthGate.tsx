"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { loginPathWithRedirect, type LoginReason } from "@/lib/navigation";
import {
  getAccountType,
  getProfessionalStatus,
  isAdminAccount,
  isProfessionalAccount,
} from "@/lib/account";
import Link from "next/link";
import { AdminMfaGate } from "@/components/admin/AdminMfaGate";
import { AuthConnectionBanner } from "@/components/AuthConnectionBanner";
import { buttonClasses, Card, Eyebrow, PageTitle } from "@/components/ui/primitives";
import {
  PROFESSIONAL_ACCESS_REQUEST_HREF,
  PROFESSIONAL_WORKSPACE_HREF,
} from "@/lib/professional-access";

const PUBLIC_PATHS = new Set([
  "/",
  "/login",
  "/sales",
  "/avocats",
  "/annonce-exemple",
  "/accompagnement",
  "/offres",
  "/a-propos",
  "/contact",
  "/ressources",
  "/ventes-immobilieres-judiciaires",
  "/legal",
  "/conditions-generales",
  "/privacy",
  "/properties",
]);
const PROFESSIONAL_PATHS = new Set(["/publish"]);
/** Pages de l'espace personnel dont la connexion s'explique sur la page de connexion. */
const LOGIN_REASON_BY_PATH: Readonly<Record<string, LoginReason>> = {
  "/favoris": "mes-favoris",
  "/alertes": "mes-alertes",
};
const ADMIN_PREFIX = "/admin";
const ADMIN_SECURITY_PATH = "/admin/securite";

function normalizePath(pathname: string) {
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "");
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { user, profile, loading, authError } = useAuth();
  const router = useRouter();
  const pathname = normalizePath(usePathname());
  const isPublic =
    PUBLIC_PATHS.has(pathname) ||
    pathname.startsWith("/ressources/") ||
    pathname.startsWith("/sales/") ||
    pathname.startsWith("/properties/") ||
    pathname.startsWith("/reports/shared/");
  const requiresProfessionalAccount = PROFESSIONAL_PATHS.has(pathname);
  const requiresAdminAccount = pathname === ADMIN_PREFIX || pathname.startsWith(`${ADMIN_PREFIX}/`);
  const isAdmin = isAdminAccount(user, profile);
  const isPendingProfessional =
    getAccountType(user, profile) === "b2b" && getProfessionalStatus(profile) !== "approved";

  useEffect(() => {
    // Une identité qui n'a pas pu être vérifiée (réseau, session rejetée) n'est pas un visiteur :
    // le bandeau propose de réessayer ou de se reconnecter, sans renvoyer d'office vers /login.
    if (isPublic || loading || user || authError) return;
    // The query string is only needed at redirect time, so it is read from the browser then:
    // subscribing to it with useSearchParams() would push every protected page out of the
    // prerendered HTML.
    const redirect = `${window.location.pathname}${window.location.search}`;
    router.replace(
      loginPathWithRedirect(redirect, { mode: "login", reason: LOGIN_REASON_BY_PATH[pathname] }),
    );
  }, [authError, isPublic, loading, pathname, router, user]);

  if (isPublic) return <>{children}</>;

  if (loading) {
    return (
      <main
        id="contenu"
        className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-4 py-10"
      >
        <Card role="status" className="w-full max-w-3xl p-6 sm:p-8">
          <Eyebrow>Accès protégé</Eyebrow>
          <PageTitle className="mt-4 text-brand-navy">Vérification de l'accès</PageTitle>
          <p className="mt-3 text-sm leading-relaxed text-ink-soft">
            Cette page est réservée aux comptes connectés.
          </p>
          <div className="mt-6 h-1.5 overflow-hidden rounded-full bg-line-soft">
            <div className="h-full w-1/2 animate-pulse rounded-full bg-gold" />
          </div>
        </Card>
      </main>
    );
  }

  if (!user) {
    if (!authError) return null;
    return (
      <main
        id="contenu"
        className="flex min-h-[calc(100vh-4rem)] items-start justify-center px-4 py-10"
      >
        <div className="w-full max-w-3xl">
          <h1 className="sr-only">Accès protégé</h1>
          <AuthConnectionBanner />
        </div>
      </main>
    );
  }

  if (requiresAdminAccount && !isAdmin) {
    return (
      <GateMessage
        badge="Admin"
        title="Accès administrateur"
        description="Cette zone est réservée au compte administrateur Immojudis."
      >
        <Link href="/sales" className={buttonClasses({ variant: "primary" })}>
          Retour aux annonces
        </Link>
      </GateMessage>
    );
  }

  if (requiresProfessionalAccount && !isProfessionalAccount(user, profile)) {
    // Un compte pro en cours de validation suit sa demande dans l'espace pro ; les autres comptes
    // demandent un accès pro par le contact (sujet « Espace professionnel »), sans impasse.
    return (
      <GateMessage
        badge="Pro"
        title={
          isPendingProfessional
            ? "Accès pro en cours de validation"
            : "Espace réservé aux professionnels"
        }
        description={
          isPendingProfessional
            ? "Votre compte professionnel doit être validé avant de transmettre une annonce."
            : "La publication d'annonces est destinée aux comptes B2B : avocats, notaires, huissiers ou commissaires de justice."
        }
      >
        {isPendingProfessional ? (
          <Link
            href={PROFESSIONAL_WORKSPACE_HREF}
            className={buttonClasses({ variant: "primary" })}
          >
            Suivre ma demande dans l'espace pro
          </Link>
        ) : (
          <Link
            href={PROFESSIONAL_ACCESS_REQUEST_HREF}
            className={buttonClasses({ variant: "primary" })}
          >
            Demander un accès pro
          </Link>
        )}
        <Link href="/sales" className={buttonClasses({ variant: "secondary" })}>
          Retour aux annonces
        </Link>
      </GateMessage>
    );
  }

  // Admin pages ask for the TOTP code first when the session is still aal1. The enrolment page
  // itself stays reachable so a fresh administrator can set the factor up.
  if (requiresAdminAccount && pathname !== ADMIN_SECURITY_PATH) {
    return (
      <>
        <AuthConnectionBanner className="mt-3" />
        <AdminMfaGate>{children}</AdminMfaGate>
      </>
    );
  }

  // Identité déjà vérifiée mais revérification impossible (réseau) : la page reste affichée.
  return (
    <>
      <AuthConnectionBanner className="mt-3" />
      {children}
    </>
  );
}

/** Accès refusé (administration, publication) : un message et des actions, sans impasse. */
function GateMessage({
  badge,
  title,
  description,
  children,
}: {
  badge: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main
      id="contenu"
      className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-4 py-10"
    >
      <Card className="max-w-lg p-6 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-line bg-surface-tint text-sm font-semibold text-gold-text">
          {badge}
        </div>
        <h1 className="mt-5 font-display text-2xl font-semibold text-brand-navy">{title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">{description}</p>
        <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">{children}</div>
      </Card>
    </main>
  );
}
