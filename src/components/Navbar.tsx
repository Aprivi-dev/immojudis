import type * as React from "react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import LogOut from "lucide-react/dist/esm/icons/log-out.js";
import Menu from "lucide-react/dist/esm/icons/menu.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { BrandLogo } from "@/components/BrandLogo";
import { isAdminAccount, isProfessionalAccount } from "@/lib/account";

const AUTH_NAV_ITEMS = [
  { to: "/sales", label: "Annonces" },
  { to: "/map", label: "Carte" },
  { to: "/favorites", label: "Favoris" },
  { to: "/alerts", label: "Alertes" },
] as const;

const PRO_NAV_ITEM = { to: "/publish", label: "Publier" } as const;
const ADMIN_NAV_ITEM = { to: "/admin", label: "Admin" } as const;
const HOME_NAV_ITEMS = [
  { to: "/sales", label: "Ventes judiciaires", chevron: true },
  { to: "/sales", label: "Rechercher un bien" },
  { to: "/contact", label: "Accompagnement" },
  { to: "/ventes-immobilieres-judiciaires", label: "Ressources" },
  { to: "/contact", label: "À propos" },
] as const;

export function Navbar() {
  const location = useLocation();
  const { user, profile, loading } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const isHome = location.pathname === "/";
  const admin = isAdminAccount(user);
  const navItems = [
    ...(user ? AUTH_NAV_ITEMS : []),
    { to: "/annonce-exemple", label: "Exemple" },
    { to: "/ventes-immobilieres-judiciaires", label: "Guide" },
    ...(isProfessionalAccount(user, profile) ? [PRO_NAV_ITEM] : []),
    ...(admin ? [ADMIN_NAV_ITEM] : []),
  ];

  useEffect(() => {
    if (!mobileOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileOpen]);

  const closeMobileMenu = () => setMobileOpen(false);

  if (isHome) {
    return (
      <header className="ij-site-header">
        <div className="ij-site-header-inner">
          <Link to="/" className="ij-home-logo" aria-label="ImmoJudis — accueil">
            <span className="ij-home-logo-mark">
              <Landmark aria-hidden className="h-6 w-6" />
            </span>
            <span>
              <strong>
                Immo<span>Judis</span>
              </strong>
              <small>L'immobilier judiciaire en toute confiance</small>
            </span>
          </Link>

          <nav className="ij-home-nav" aria-label="Navigation principale">
            {HOME_NAV_ITEMS.map((item) => (
              <Link key={item.label} to={item.to}>
                {item.label}
                {item.chevron ? <ChevronDown aria-hidden className="h-4 w-4" /> : null}
              </Link>
            ))}
          </nav>

          <div className="ij-home-actions">
            <Link to="/login" className="ij-login-button">
              Connexion
            </Link>
            <Link to="/login" className="ij-signup-button">
              S'inscrire
            </Link>
          </div>

          <button
            type="button"
            aria-label="Ouvrir le menu"
            aria-controls="home-mobile-navigation"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen(true)}
            className="ij-home-menu-button"
          >
            <Menu className="h-5 w-5" />
          </button>
        </div>

        {mobileOpen ? (
          <div className="ij-mobile-overlay" role="dialog" aria-modal="true">
            <button
              type="button"
              aria-label="Fermer le menu"
              className="ij-mobile-backdrop"
              onClick={closeMobileMenu}
            />
            <aside id="home-mobile-navigation" className="ij-mobile-panel">
              <div className="ij-mobile-panel-head">
                <Link to="/" onClick={closeMobileMenu} className="ij-home-logo">
                  <span className="ij-home-logo-mark">
                    <Landmark aria-hidden className="h-6 w-6" />
                  </span>
                  <span>
                    <strong>
                      Immo<span>Judis</span>
                    </strong>
                    <small>L'immobilier judiciaire en toute confiance</small>
                  </span>
                </Link>
                <button type="button" aria-label="Fermer le menu" onClick={closeMobileMenu}>
                  <X className="h-5 w-5" />
                </button>
              </div>

              <nav className="ij-mobile-nav" aria-label="Navigation mobile">
                {HOME_NAV_ITEMS.map((item) => (
                  <Link key={item.label} to={item.to} onClick={closeMobileMenu}>
                    {item.label}
                  </Link>
                ))}
              </nav>

              <div className="ij-mobile-actions">
                <Link to="/login" onClick={closeMobileMenu} className="ij-login-button">
                  Connexion
                </Link>
                <Link to="/login" onClick={closeMobileMenu} className="ij-signup-button">
                  S'inscrire
                </Link>
              </div>
            </aside>
          </div>
        ) : null}
      </header>
    );
  }

  return (
    <header className="app-navbar sticky top-0 z-40 border-b border-white/10 bg-background/62 shadow-[0_18px_54px_rgb(0_0_0_/_22%)] backdrop-blur-2xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2.5">
          <BrandLogo
            markVariant="transparent"
            markClassName="h-7 w-7 sm:h-8 sm:w-8"
            textClassName="text-sm sm:text-base"
          />
        </Link>

        <nav className="hidden items-center gap-2 text-xs font-medium uppercase text-muted-foreground md:flex">
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to}>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          {!loading && user ? (
            <button
              onClick={() => supabase.auth.signOut()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs uppercase text-muted-foreground transition-colors hover:text-foreground"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Déconnexion</span>
            </button>
          ) : (
            <Link
              to="/login"
              className="liquid-panel-soft px-5 py-2 text-xs font-semibold uppercase text-[var(--gold)] transition-all hover:border-[var(--gold)] hover:text-[var(--gold-soft)]"
            >
              Accès Investisseur
            </Link>
          )}
        </div>

        <button
          type="button"
          aria-label="Ouvrir le menu"
          aria-controls="mobile-navigation"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen(true)}
          className="liquid-panel-soft inline-flex h-10 w-10 items-center justify-center text-foreground transition-colors hover:border-[var(--gold)] hover:text-[var(--gold)] md:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
      </div>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Fermer le menu"
            className="absolute inset-0 bg-black/55 backdrop-blur-sm"
            onClick={closeMobileMenu}
          />
          <aside
            id="mobile-navigation"
            className="liquid-panel absolute right-3 top-3 flex h-[calc(100svh-1.5rem)] w-[min(88vw,22rem)] flex-col overflow-hidden border-white/10 bg-background/92"
          >
            <div className="flex items-start justify-between gap-4 border-b border-white/10 p-5">
              <BrandLogo
                showTagline
                markVariant="transparent"
                markClassName="h-10 w-10"
                textClassName="text-lg"
              />
              <button
                type="button"
                aria-label="Fermer le menu"
                onClick={closeMobileMenu}
                className="liquid-panel-soft inline-flex h-10 w-10 shrink-0 items-center justify-center text-foreground transition-colors hover:border-[var(--gold)] hover:text-[var(--gold)]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex min-h-0 flex-1 flex-col p-6">
              <nav className="grid gap-2 text-sm font-medium uppercase text-muted-foreground">
                {navItems.map((item) => (
                  <MobileNavLink key={item.to} to={item.to} onClick={closeMobileMenu}>
                    {item.label}
                  </MobileNavLink>
                ))}
              </nav>

              <div className="mt-auto border-t border-white/10 pt-6">
                {!loading && user ? (
                  <button
                    onClick={() => {
                      closeMobileMenu();
                      void supabase.auth.signOut();
                    }}
                    className="liquid-panel-soft inline-flex w-full items-center justify-center gap-2 px-4 py-3 text-xs font-semibold uppercase text-muted-foreground transition-colors hover:border-[var(--gold)] hover:text-[var(--gold)]"
                  >
                    <LogOut className="h-4 w-4" />
                    Déconnexion
                  </button>
                ) : (
                  <Link
                    to="/login"
                    onClick={closeMobileMenu}
                    className="liquid-button inline-flex w-full items-center justify-center rounded-lg px-4 py-3 text-xs font-semibold uppercase text-background transition-colors hover:brightness-105"
                  >
                    Accès Investisseur
                  </Link>
                )}
              </div>
            </div>
          </aside>
        </div>
      ) : null}
    </header>
  );
}

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: true }}
      className="rounded-full px-3 py-2 transition-colors hover:bg-white/5 hover:text-[var(--gold)]"
      activeProps={{ className: "bg-gold/10 text-[var(--gold)]" }}
    >
      {children}
    </Link>
  );
}

function MobileNavLink({
  to,
  children,
  onClick,
}: {
  to: string;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <Link
      to={to}
      onClick={onClick}
      activeOptions={{ exact: true }}
      className="border-b border-white/10 py-4 transition-colors hover:text-[var(--gold)]"
      activeProps={{ className: "text-[var(--gold)]" }}
    >
      {children}
    </Link>
  );
}
