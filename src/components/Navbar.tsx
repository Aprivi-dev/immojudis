import type * as React from "react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import Form from "next/form";
import { Link } from "@/lib/router-compat";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import LogOut from "lucide-react/dist/esm/icons/log-out.js";
import Menu from "lucide-react/dist/esm/icons/menu.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { BrandMark } from "@/components/BrandLogo";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { getAccountType, isAdminAccount } from "@/lib/account";
import { RESOURCES_PATH } from "@/lib/navigation";

const AlertNotificationCenter = dynamic(() =>
  import("@/components/AlertNotificationCenter").then((module) => module.AlertNotificationCenter),
);

const AUTH_NAV_ITEMS = [
  { to: "/favoris", label: "Mes favoris" },
  { to: "/alertes", label: "Mes alertes" },
  { to: "/comparaisons", label: "Mes comparaisons" },
  { to: "/compte", label: "Mon compte" },
  { to: "/sales", label: "Annonces" },
  { to: "/tribunaux", label: "Statistiques Tribunaux" },
  { to: "/avocats", label: "Avocats" },
] as const;

const PRO_NAV_ITEM = { to: "/espace-pro", label: "Espace pro" } as const;
const ADMIN_NAV_ITEM = { to: "/admin", label: "Admin" } as const;
const HOME_NAV_ITEMS = [
  { to: "/comment-ca-marche", label: "Comment ça marche" },
  { to: "/sales", label: "Rechercher un bien" },
  { to: "/tribunaux", label: "Statistiques Tribunaux" },
  { to: "/avocats", label: "Trouver un avocat" },
  { to: "/annonce-exemple", label: "Annonce exemple" },
  { to: "/accompagnement", label: "Offres" },
  { to: RESOURCES_PATH, label: "Ressources" },
  { to: "/a-propos", label: "À propos" },
] as const;
const NON_HOME_PUBLIC_NAV_ITEMS = HOME_NAV_ITEMS.filter((item) => item.to !== "/annonce-exemple");
const HOME_HEADER_NAV_ITEMS = [
  { to: "/sales", label: "Les ventes" },
  { to: "/comment-ca-marche", label: "Comment ça marche" },
  { to: "/accompagnement", label: "Offres" },
] as const;

export function Navbar() {
  const pathname = usePathname();
  const { user, profile, loading } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const isHome = pathname === "/";
  const isAdminArea = pathname === "/admin" || pathname.startsWith("/admin/");
  const isSalesListing = pathname === "/sales" || pathname === "/sales/";
  const isProductPage = pathname === "/annonce-exemple" || /^\/sales\/[^/]+/.test(pathname);
  const mobileNavigationVisible = mobileOpen && !isAdminArea && !isSalesListing;
  const admin = isAdminAccount(user, profile);
  const professionalWorkspace = admin || getAccountType(user, profile) === "b2b";
  const navItems = user
    ? [
        ...AUTH_NAV_ITEMS,
        { to: RESOURCES_PATH, label: "Ressources" },
        ...(professionalWorkspace ? [PRO_NAV_ITEM] : []),
        ...(admin ? [ADMIN_NAV_ITEM] : []),
      ]
    : isHome
      ? HOME_NAV_ITEMS
      : NON_HOME_PUBLIC_NAV_ITEMS;

  useEffect(() => {
    if (!mobileNavigationVisible) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileNavigationVisible]);

  const closeMobileMenu = () => setMobileOpen(false);

  if (isAdminArea) return null;

  if (isSalesListing) return null;

  if (isProductPage) {
    return (
      <>
        <header className="fixed inset-x-0 top-0 z-50 border-b border-border bg-white/95 text-foreground shadow-sm backdrop-blur">
          <div className="flex h-16 w-full items-center gap-4 px-4 sm:px-6 lg:px-8">
            <Link
              to="/"
              className="inline-flex shrink-0 items-center gap-2 font-display text-2xl font-semibold text-foreground"
              aria-label="ImmoJudis — accueil"
            >
              <BrandMark variant="transparent" className="h-7 w-7" />
              <span>
                Immo<span className="text-[#8a5b24]">Judis</span>
              </span>
            </Link>

            <Form
              action="/sales"
              className="hidden min-w-0 max-w-xl flex-1 items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm shadow-inner md:flex"
            >
              <button
                type="submit"
                aria-label="Rechercher"
                className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
              >
                <Search className="h-4 w-4" />
              </button>
              <label htmlFor="product-search" className="sr-only">
                Rechercher par région, département, ville ou code postal
              </label>
              <input
                id="product-search"
                name="q"
                type="search"
                placeholder="Région, département, ville, code postal..."
                autoComplete="off"
                className="w-full bg-transparent font-medium text-foreground outline-none placeholder:text-muted-foreground"
              />
            </Form>

            <nav
              className="hidden items-center gap-1 text-sm font-semibold text-foreground lg:flex"
              aria-label="Navigation produit"
            >
              {navItems.slice(0, 5).map((item) => (
                <NavLink key={item.label} to={item.to} chevron={hasNavChevron(item)}>
                  {item.label}
                </NavLink>
              ))}
            </nav>

            <div className="ml-auto hidden shrink-0 items-center gap-2 md:flex">
              {!loading && user ? (
                <>
                  <AlertNotificationCenter />
                  <button
                    type="button"
                    onClick={() => supabase.auth.signOut()}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm font-semibold hover:border-gold/50 hover:text-gold-soft"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    Déconnexion
                  </button>
                </>
              ) : (
                <>
                  <Link
                    to="/login"
                    search={{ redirect: undefined }}
                    className="rounded-md border border-border bg-white px-3 py-2 text-sm font-semibold hover:border-gold/50 hover:text-gold-soft"
                  >
                    Connexion
                  </Link>
                  <Link
                    to="/login"
                    search={{ mode: "investor", redirect: undefined }}
                    className="rounded-md bg-gold-soft px-3 py-2 text-sm font-semibold text-white hover:bg-gold"
                  >
                    S'inscrire
                  </Link>
                </>
              )}
            </div>

            <button
              type="button"
              aria-label="Ouvrir le menu"
              aria-controls="product-mobile-navigation"
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen(true)}
              className="ml-auto inline-grid h-10 w-10 shrink-0 place-items-center rounded-md border border-border bg-white lg:hidden"
            >
              <Menu className="h-5 w-5" />
            </button>
          </div>

          {mobileOpen ? (
            <MobileNavigationDialog id="product-mobile-navigation" onClose={closeMobileMenu}>
              <div className="ij-mobile-panel-head">
                <HeaderLogo onClick={closeMobileMenu} />
                <button type="button" aria-label="Fermer le menu" onClick={closeMobileMenu}>
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="flex min-h-0 flex-1 flex-col">
                <Form
                  action="/sales"
                  onSubmit={closeMobileMenu}
                  className="mb-3 flex items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm"
                >
                  <button
                    type="submit"
                    aria-label="Rechercher"
                    className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
                  >
                    <Search className="h-4 w-4" />
                  </button>
                  <label htmlFor="product-mobile-search" className="sr-only">
                    Rechercher par région, département, ville ou code postal
                  </label>
                  <input
                    id="product-mobile-search"
                    name="q"
                    type="search"
                    placeholder="Région, département, ville, CP..."
                    autoComplete="off"
                    className="w-full bg-transparent outline-none"
                  />
                </Form>
                <nav className="ij-mobile-nav" aria-label="Navigation mobile">
                  {navItems.map((item) => (
                    <MobileNavLink key={item.label} to={item.to} onClick={closeMobileMenu}>
                      {item.label}
                    </MobileNavLink>
                  ))}
                </nav>
                <div className="ij-mobile-actions">
                  {!loading && user ? (
                    <>
                      <AlertNotificationCenter mobile />
                      <button
                        type="button"
                        className="ij-login-button w-full"
                        onClick={() => {
                          closeMobileMenu();
                          void supabase.auth.signOut();
                        }}
                      >
                        Déconnexion
                      </button>
                    </>
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
                        search={{ mode: "investor" }}
                        onClick={closeMobileMenu}
                        className="ij-signup-button w-full"
                      >
                        S’inscrire
                      </Link>
                    </>
                  )}
                </div>
              </div>
            </MobileNavigationDialog>
          ) : null}
        </header>
        <div className="h-16" aria-hidden />
      </>
    );
  }

  if (isHome) {
    return (
      <header className="ij-site-header ij-cinematic-header">
        <div className="ij-site-header-inner">
          <HeaderLogo />

          <nav className="ij-home-nav" aria-label="Navigation principale">
            {HOME_HEADER_NAV_ITEMS.map((item) => (
              <Link key={item.label} to={item.to}>
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="ij-home-actions">
            {!loading && user ? (
              <>
                <Link
                  to={professionalWorkspace ? "/espace-pro" : "/favoris"}
                  className="ij-login-button"
                >
                  Mon espace
                </Link>
                <button
                  type="button"
                  onClick={() => void supabase.auth.signOut()}
                  className="ij-login-button"
                >
                  Déconnexion
                </button>
              </>
            ) : (
              <>
                <Link to="/login" search={{ redirect: undefined }} className="ij-login-button">
                  Connexion
                </Link>
                <Link
                  to="/login"
                  search={{ mode: "investor", redirect: undefined }}
                  className="ij-signup-button"
                >
                  S'inscrire
                </Link>
              </>
            )}
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
          <MobileNavigationDialog id="home-mobile-navigation" onClose={closeMobileMenu}>
            <div className="ij-mobile-panel-head">
              <HeaderLogo onClick={closeMobileMenu} />
              <button type="button" aria-label="Fermer le menu" onClick={closeMobileMenu}>
                <X className="h-5 w-5" />
              </button>
            </div>

            <nav className="ij-mobile-nav" aria-label="Navigation mobile">
              {navItems.map((item) => (
                <Link key={item.label} to={item.to} onClick={closeMobileMenu}>
                  {item.label}
                </Link>
              ))}
            </nav>

            <div className="ij-mobile-actions">
              {!loading && user ? (
                <button
                  type="button"
                  onClick={() => {
                    closeMobileMenu();
                    void supabase.auth.signOut();
                  }}
                  className="ij-login-button w-full"
                >
                  Déconnexion
                </button>
              ) : (
                <>
                  <Link
                    to="/login"
                    search={{ redirect: undefined }}
                    onClick={closeMobileMenu}
                    className="ij-login-button"
                  >
                    Connexion
                  </Link>
                  <Link
                    to="/login"
                    search={{ mode: "investor", redirect: undefined }}
                    onClick={closeMobileMenu}
                    className="ij-signup-button"
                  >
                    S'inscrire
                  </Link>
                </>
              )}
            </div>
          </MobileNavigationDialog>
        ) : null}
      </header>
    );
  }

  return (
    <>
      <header className={`ij-site-header${user ? " ij-site-header-account" : ""}`}>
        <div className="ij-site-header-inner">
          <HeaderLogo />

          <nav className="ij-home-nav" aria-label="Navigation principale">
            {navItems.map((item) => (
              <NavLink key={item.label} to={item.to} chevron={hasNavChevron(item)}>
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ij-home-actions">
            {!loading && user ? (
              <>
                <AlertNotificationCenter />
                <button onClick={() => supabase.auth.signOut()} className="ij-login-button gap-2">
                  <LogOut className="h-3.5 w-3.5" />
                  <span>Déconnexion</span>
                </button>
              </>
            ) : (
              <>
                <Link to="/login" search={{ redirect: undefined }} className="ij-login-button">
                  Connexion
                </Link>
                <Link
                  to="/login"
                  search={{ mode: "investor", redirect: undefined }}
                  className="ij-signup-button"
                >
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
          <MobileNavigationDialog id="mobile-navigation" onClose={closeMobileMenu}>
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
                  <>
                    <AlertNotificationCenter mobile />
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
                  </>
                ) : (
                  <>
                    <Link
                      to="/login"
                      search={{ redirect: undefined }}
                      onClick={closeMobileMenu}
                      className="ij-login-button w-full"
                    >
                      Connexion
                    </Link>
                    <Link
                      to="/login"
                      search={{ mode: "investor", redirect: undefined }}
                      onClick={closeMobileMenu}
                      className="ij-signup-button w-full"
                    >
                      S'inscrire
                    </Link>
                  </>
                )}
              </div>
            </div>
          </MobileNavigationDialog>
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
        <small>Les ventes immobilières en toute clarté</small>
      </span>
    </Link>
  );
}

function hasNavChevron(item: { readonly to: string; readonly label: string }): boolean {
  return "chevron" in item && (item as { readonly chevron?: unknown }).chevron === true;
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
      className="rounded-full px-3 py-2 transition-colors hover:bg-[#c98d45]/10 hover:text-[#8a5b24]"
      activeProps={{ className: "bg-[#c98d45]/10 text-[#8a5b24]" }}
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
      className="border-b border-[rgb(19_34_56_/_8%)] py-4 transition-colors hover:text-[#8a5b24]"
      activeProps={{ className: "text-[#8a5b24]" }}
    >
      {children}
    </Link>
  );
}

function MobileNavigationDialog({
  id,
  onClose,
  children,
}: {
  id: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const previousFocus = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className="ij-mobile-overlay">
        <DialogPrimitive.Overlay className="ij-mobile-backdrop" onClick={onClose} />
        <DialogPrimitive.Content
          id={id}
          className="ij-mobile-panel"
          aria-describedby={undefined}
          onOpenAutoFocus={() => {
            previousFocus.current = document.activeElement as HTMLElement | null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (previousFocus.current?.isConnected) previousFocus.current.focus();
          }}
        >
          <DialogPrimitive.Title className="sr-only">Menu de navigation</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </div>
    </DialogPrimitive.Root>
  );
}
