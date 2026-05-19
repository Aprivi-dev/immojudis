import { Link } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { Gavel, LogOut } from "lucide-react";

export function Navbar() {
  const { user, loading } = useAuth();

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4">
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <Gavel className="h-5 w-5 text-primary" />
          <span>Enchères Immo</span>
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          <NavLink to="/sales">Annonces</NavLink>
          <NavLink to="/map">Carte</NavLink>
          <NavLink to="/favorites">Favoris</NavLink>
          <NavLink to="/alerts">Alertes</NavLink>
          {!loading && user ? (
            <button
              onClick={() => supabase.auth.signOut()}
              className="ml-2 inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Déconnexion</span>
            </button>
          ) : (
            <Link to="/login" className="ml-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">
              Connexion
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="rounded-md px-3 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      activeProps={{ className: "rounded-md px-3 py-1.5 bg-accent text-foreground font-medium" }}
    >
      {children}
    </Link>
  );
}