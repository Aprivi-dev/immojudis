import { useEffect, useMemo } from "react";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, ShieldCheck, Clock, LogOut } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { getMyProfile } from "@/lib/profile.functions";

// Routes accessibles sans connexion ni validation
const PUBLIC_PATHS = ["/", "/login", "/reset-password"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.includes(pathname);
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const router = useRouter();
  const qc = useQueryClient();
  const fetchProfile = useServerFn(getMyProfile);

  const isPublic = useMemo(() => isPublicPath(location.pathname), [location.pathname]);

  // Invalidate caches on auth change
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      router.invalidate();
      qc.invalidateQueries();
    });
    return () => sub.subscription.unsubscribe();
  }, [router, qc]);

  const profileQuery = useQuery({
    queryKey: ["my-profile", user?.id],
    queryFn: () => fetchProfile(),
    enabled: !!user && !isPublic,
    staleTime: 30_000,
  });

  // Redirect to /login if not authenticated and route protected
  useEffect(() => {
    if (loading) return;
    if (!user && !isPublic) {
      navigate({ to: "/login", search: { redirect: location.pathname } as never });
    }
  }, [loading, user, isPublic, navigate, location.pathname]);

  // Public route → render as-is
  if (isPublic) return <>{children}</>;

  // Loading session
  if (loading || (user && profileQuery.isLoading)) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Not logged in (redirect will fire)
  if (!user) return null;

  // Logged in but not approved
  if (profileQuery.data && !profileQuery.data.is_approved) {
    return <PendingApprovalScreen email={user.email ?? profileQuery.data.email ?? ""} />;
  }

  // Approved → render protected content
  return <>{children}</>;
}

function PendingApprovalScreen({ email }: { email: string }) {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-xl flex-col items-center justify-center px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center border border-[var(--gold)] text-[var(--gold)]">
        <Clock className="h-6 w-6" />
      </div>
      <h1 className="mt-6 font-display text-3xl font-bold tracking-tight text-foreground">
        Compte en attente de validation
      </h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
        Merci pour votre inscription. Votre accès à l'outil est en cours de revue
        manuelle par un administrateur. Vous recevrez une confirmation dès que
        votre compte sera activé.
      </p>
      <div className="mt-6 flex items-center gap-2 border border-border bg-card px-4 py-2 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5 text-[var(--gold)]" />
        <span>{email}</span>
      </div>
      <button
        onClick={() => supabase.auth.signOut()}
        className="mt-8 inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-muted-foreground transition-colors hover:text-foreground"
      >
        <LogOut className="h-3.5 w-3.5" />
        Se déconnecter
      </button>
    </main>
  );
}