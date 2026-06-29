import type * as React from "react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import LogOut from "lucide-react/dist/esm/icons/log-out.js";
import Menu from "lucide-react/dist/esm/icons/menu.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { BrandMark } from "@/components/BrandLogo";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { isAdminAccount, isProfessionalAccount } from "@/lib/account";

const AUTH_NAV_ITEMS = [
  { to: "/sales", label: "Annonces" },
  { to: "/favorites", label: "Favoris" },
  { to: "/alerts", label: "Alertes" },
] as const;

const PRO_NAV_ITEM = { to: "/publish", label: "Publier" } as const;
const ADMIN_NAV_ITEM = { to: "/admin", label: "Admin" } as const;
const HOME_NAV_ITEMS = [
  { to: "/sales", label: "Ventes judiciaires", chevron: true },
  { to: "/sales", label: "Rechercher un bien" },
  { to: "/annonce-exemple", label: "Annonce exemple" },
  { to: "/accompagnement", label: "Accompagnement" },
  { to: "/ressources", label: "Ressources" },
  { to: "/a-propos", label: "À propos" },
] as const;

export function Navbar() {
  const location = useLocation();
  const { user, profile, loading } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const isHome = location.pathname === "/";
  const admin = isAdminAccount(user);
  const navItems = user
    ? [
        ...AUTH_NAV_ITEMS,
        { to: "/ressources", label: "Ressources" },
        ...(isProfessionalAccount(user, profile) ? [PRO_NAV_ITEM] : []),
        ...(admin ? [ADMIN_NAV_ITEM] : []),
      ]
    : HOME_NAV_ITEMS;

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
          <HeaderLogo />

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
                <HeaderLogo onClick={closeMobileMenu} />
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
    <>
      <header className="ij-site-header">
        <div className="ij-site-header-inner">
          <HeaderLogo />

          <nav className="ij-home-nav" aria-label="Navigation principale">
            {navItems.map((item) => (
              <NavLink key={item.label} to={item.to} chevron={"chevron" in item && item.chevron}>
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ij-home-actions">
            {!loading && user ? (
              <button onClick={() => supabase.auth.signOut()} className="ij-login-button gap-2">
                <LogOut className="h-3.5 w-3.5" />
                <span>Déconnexion</span>
              </button>
            ) : (
              <>
                <Link to="/login" className="ij-login-button">
                  Connexion
                </Link>
                <Link to="/login" className="ij-signup-button">
                  S'inscrire
                </Link>
              </>
            )}
          </div>

          <button
            type="button"
            aria-label="Ouvrir le menu"
            aria-controls="mobile-navigation"
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
            <aside id="mobile-navigation" className="ij-mobile-panel">
              <div className="ij-mobile-panel-head">
                <HeaderLogo onClick={closeMobileMenu} />
                <button type="button" aria-label="Fermer le menu" onClick={closeMobileMenu}>
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="flex min-h-0 flex-1 flex-col">
                <nav className="ij-mobile-nav" aria-label="Navigation mobile">
                  {navItems.map((item) => (
                    <MobileNavLink key={item.label} to={item.to} onClick={closeMobileMenu}>
                      {item.label}
                    </MobileNavLink>
                  ))}
                </nav>

                <div className="ij-mobile-actions">
                  {!loading && user ? (
                    <button
                      onClick={() => {
                        closeMobileMenu();
                        void supabase.auth.signOut();
                      }}
                      className="ij-login-button w-full gap-2"
                    >
                      <LogOut className="h-4 w-4" />
                      Déconnexion
                    </button>
                  ) : (
                    <>
                      <Link
                        to="/login"
                        onClick={closeMobileMenu}
                        className="ij-login-button w-full"
                      >
                        Connexion
                      </Link>
                      <Link
                        to="/login"
                        onClick={closeMobileMenu}
                        className="ij-signup-button w-full"
                      >
                        S'inscrire
                      </Link>
                    </>
                  )}
                </div>
              </div>
            </aside>
          </div>
        ) : null}
      </header>
      <div className="ij-header-spacer" aria-hidden />
    </>
  );
}

function HeaderLogo({ onClick }: { onClick?: () => void }) {
  return (
    <Link to="/" onClick={onClick} className="ij-home-logo" aria-label="ImmoJudis — accueil">
      <span className="ij-home-logo-mark" aria-hidden="true">
        <BrandMark variant="transparent" className="h-6 w-6" />
      </span>
      <span>
        <strong>
          Immo<span>Judis</span>
        </strong>
        <small>L'immobilier judiciaire en toute confiance</small>
      </span>
    </Link>
  );
}

function NavLink({
  to,
  children,
  chevron,
}: {
  to: string;
  children: React.ReactNode;
  chevron?: boolean;
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: true }}
      className="rounded-full px-3 py-2 transition-colors hover:bg-[#c98d45]/10 hover:text-[#9c642b]"
      activeProps={{ className: "bg-[#c98d45]/10 text-[#9c642b]" }}
    >
      {children}
      {chevron ? <ChevronDown aria-hidden className="h-4 w-4" /> : null}
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
      className="border-b border-[rgb(19_34_56_/_8%)] py-4 transition-colors hover:text-[#9c642b]"
      activeProps={{ className: "text-[#9c642b]" }}
    >
      {children}
    </Link>
  );
}
