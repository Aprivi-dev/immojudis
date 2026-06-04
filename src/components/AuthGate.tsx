import type { ReactNode } from "react";
import { useEffect } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";

const PUBLIC_PATHS = new Set(["/", "/login"]);

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

  return <>{children}</>;
}
