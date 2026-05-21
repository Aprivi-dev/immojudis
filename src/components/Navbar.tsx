import { Link } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { Gavel, LogOut } from "lucide-react";

export function Navbar() {
  const { user, loading } = useAuth();

  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <Link to="/" className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center bg-[var(--gold)]">
            <Gavel className="h-4 w-4 text-[var(--background)]" />
          </span>
          <span className="font-display text-lg font-bold tracking-tight">
            Enchères Immo
          </span>
        </Link>

        <nav className="hidden items-center gap-7 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground md:flex">
          <NavLink to="/sales">Annonces</NavLink>
          <NavLink to="/sales/new">Nouveautés</NavLink>
          <NavLink to="/map">Carte</NavLink>
          <NavLink to="/favorites">Favoris</NavLink>
          <NavLink to="/alerts">Alertes</NavLink>
        </nav>

        <div className="flex items-center gap-2">
          {!loading && user ? (
            <button
              onClick={() => supabase.auth.signOut()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] uppercase tracking-[0.2em] text-muted-foreground transition-colors hover:text-foreground"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Déconnexion</span>
            </button>
          ) : (
            <Link
              to="/login"
              className="border border-[var(--gold)] px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--gold)] transition-all hover:bg-[var(--gold)] hover:text-[var(--background)]"
            >
              Accès Investisseur
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="transition-colors hover:text-[var(--gold)]"
      activeProps={{ className: "text-[var(--gold)]" }}
    >
      {children}
    </Link>
  );
}