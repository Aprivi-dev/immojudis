import type { ReactNode } from "react";
import { useEffect } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";
import {
  getAccountType,
  getProfessionalStatus,
  isAdminAccount,
  isProfessionalAccount,
} from "@/lib/account";
import { BrandMark } from "@/components/BrandLogo";

const PUBLIC_PATHS = new Set(["/", "/login", "/ventes-immobilieres-judiciaires"]);
const PROFESSIONAL_PATHS = new Set(["/publish"]);
const ADMIN_PREFIX = "/admin";

function normalizePath(pathname: string) {
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "");
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { user, profile, loading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const pathname = normalizePath(location.pathname);
  const isPublic = PUBLIC_PATHS.has(pathname);
  const requiresProfessionalAccount = PROFESSIONAL_PATHS.has(pathname);
  const requiresAdminAccount = pathname === ADMIN_PREFIX || pathname.startsWith(`${ADMIN_PREFIX}/`);
  const isAdmin = isAdminAccount(user);
  const isPendingProfessional =
    getAccountType(user, profile) === "b2b" && getProfessionalStatus(profile) !== "approved";

  useEffect(() => {
    if (isPublic || loading || user) return;
    void navigate({ to: "/login", replace: true });
  }, [isPublic, loading, navigate, user]);

  if (isPublic) return <>{children}</>;

  if (loading) {
    return (
      <main className="liquid-page flex min-h-[calc(100vh-4rem)] items-center justify-center px-4 py-10">
        <div className="glass-shell grid w-full max-w-3xl overflow-hidden rounded-lg sm:grid-cols-[1fr_15rem]">
          <div className="p-6 sm:p-8">
            <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-gold">
              Accès protégé
            </div>
            <h1 className="mt-4 font-display text-3xl leading-tight text-foreground">
              Vérification de l'accès
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Les annonces, cartes et analyses Immojudis sont réservées aux comptes connectés.
            </p>
            <div className="mt-6 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full w-1/2 animate-pulse rounded-full bg-gold" />
            </div>
          </div>
          <div className="relative hidden min-h-[13rem] overflow-hidden sm:block">
            <div className="cinematic-grid absolute inset-0 opacity-40" />
            <BrandMark
              variant="transparent"
              className="absolute bottom-8 right-8 h-28 w-28 opacity-35 drop-shadow-[0_26px_52px_rgba(0,0,0,0.48)]"
            />
          </div>
        </div>
      </main>
    );
  }

  if (!user) return null;

  if (requiresAdminAccount && !isAdmin) {
    return (
      <main className="liquid-page flex min-h-[calc(100vh-4rem)] items-center justify-center px-4 py-10">
        <div className="liquid-panel max-w-lg rounded-lg p-6 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-gold/25 bg-gold/10 text-gold">
            Admin
          </div>
          <h1 className="mt-5 font-display text-2xl text-foreground">Accès administrateur</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Cette zone est réservée au compte administrateur Immojudis.
          </p>
          <div className="mt-6 flex justify-center">
            <a
              href="/sales"
              className="liquid-button inline-flex items-center justify-center rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.18em] text-background"
            >
              Retour aux annonces
            </a>
          </div>
        </div>
      </main>
    );
  }

  if (requiresProfessionalAccount && !isProfessionalAccount(user, profile)) {
    return (
      <main className="liquid-page flex min-h-[calc(100vh-4rem)] items-center justify-center px-4 py-10">
        <div className="liquid-panel max-w-lg rounded-lg p-6 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-gold/25 bg-gold/10 text-gold">
            Pro
          </div>
          <h1 className="mt-5 font-display text-2xl text-foreground">
            {isPendingProfessional
              ? "Accès pro en cours de validation"
              : "Espace réservé aux professionnels"}
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            {isPendingProfessional
              ? "Votre compte professionnel doit être validé avant de transmettre une annonce."
              : "La publication d'annonces est destinée aux comptes B2B : avocats, notaires, huissiers ou commissaires de justice."}
          </p>
          <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
            <a
              href="/sales"
              className="liquid-button inline-flex items-center justify-center rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.18em] text-background"
            >
              Retour aux annonces
            </a>
            <a
              href="/contact"
              className="liquid-panel-soft inline-flex items-center justify-center rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.18em] text-gold hover:border-gold"
            >
              Demander un accès pro
            </a>
          </div>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}
