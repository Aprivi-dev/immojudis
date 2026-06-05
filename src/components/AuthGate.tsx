import type { ReactNode } from "react";
import { useEffect } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";
import { isAdminAccount, isProfessionalAccount } from "@/lib/account";

const PUBLIC_PATHS = new Set(["/", "/login"]);
const PROFESSIONAL_PATHS = new Set(["/publish"]);
const ADMIN_PREFIX = "/admin";

function normalizePath(pathname: string) {
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "");
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const pathname = normalizePath(location.pathname);
  const isPublic = PUBLIC_PATHS.has(pathname);
  const requiresProfessionalAccount = PROFESSIONAL_PATHS.has(pathname);
  const requiresAdminAccount = pathname === ADMIN_PREFIX || pathname.startsWith(`${ADMIN_PREFIX}/`);
  const isAdmin = isAdminAccount(user);

  useEffect(() => {
    if (isPublic || loading || user) return;
    void navigate({ to: "/login", replace: true });
  }, [isPublic, loading, navigate, user]);

  if (isPublic) return <>{children}</>;

  if (loading) {
    return (
      <main className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-4">
        <div className="liquid-panel max-w-sm rounded-lg p-6 text-center">
          <div className="mx-auto h-10 w-10 animate-pulse rounded-full border border-gold/35 bg-gold/10" />
          <p className="mt-4 text-sm font-medium text-foreground">Vérification de l'accès</p>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Les annonces Immojudis sont réservées aux comptes connectés.
          </p>
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

  if (requiresProfessionalAccount && !isProfessionalAccount(user)) {
    return (
      <main className="liquid-page flex min-h-[calc(100vh-4rem)] items-center justify-center px-4 py-10">
        <div className="liquid-panel max-w-lg rounded-lg p-6 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-gold/25 bg-gold/10 text-gold">
            Pro
          </div>
          <h1 className="mt-5 font-display text-2xl text-foreground">
            Espace réservé aux professionnels
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            La publication d'annonces est destinée aux comptes B2B : avocats, notaires,
            huissiers ou commissaires de justice. Votre compte actuel reste orienté investisseur.
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
