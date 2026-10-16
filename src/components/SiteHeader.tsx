"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import Menu from "lucide-react/dist/esm/icons/menu.js";
import {
  buttonBase,
  darkGhost,
  goldButton,
  HeaderLogo,
  isActive,
  lightGhost,
} from "@/components/site-header-shared";
import { MobileMenuDialog } from "@/components/SiteHeaderMobileMenu";
import { useAuth } from "@/hooks/use-auth";
import { getAccountType, isAdminAccount } from "@/lib/account";
import { ACCOUNT_LINKS, linkPrefetch, SITE_NAV_LINKS, type SiteLink } from "@/lib/navigation";
import { cn } from "@/lib/utils";

const AlertNotificationCenter = dynamic(() =>
  import("@/components/AlertNotificationCenter").then((module) => module.AlertNotificationCenter),
);

// Radix Popover (menu « Mon compte ») n'est chargé que pour une personne connectée. Radix Dialog
// (menu mobile) reste dans le JavaScript commun : d'autres pages l'importent aussi, et un import
// dynamique ici ferait copier le module dans chacun de leurs fichiers (mesuré : +30 Ko par copie).
const AccountMenu = lazy(() =>
  import("@/components/SiteHeaderAccountMenu").then((module) => ({ default: module.AccountMenu })),
);

export type SiteHeaderTheme = "dark" | "light";

type SiteHeaderProps = {
  /** « dark » pour l'accueil (par-dessus la photo), « light » partout ailleurs. */
  theme?: SiteHeaderTheme;
  /** « fixed » réserve la hauteur de la barre ; « sticky » laisse la page s'en charger. */
  placement?: "fixed" | "sticky";
  /** Contenu inséré entre le logo et la navigation (barre de recherche du catalogue). */
  center?: ReactNode;
  /** Rangée supplémentaire sous la barre (filtres du catalogue). */
  belowBar?: ReactNode;
  className?: string;
  headerRef?: Ref<HTMLElement>;
};

export function SiteHeader({
  theme = "light",
  placement = "fixed",
  center,
  belowBar,
  className,
  headerRef,
}: SiteHeaderProps) {
  const pathname = usePathname();
  const { user, profile, loading } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const dark = theme === "dark";
  const signedIn = !loading && Boolean(user);
  const admin = isAdminAccount(user, profile);
  const professional = admin || getAccountType(user, profile) === "b2b";

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  const accountLinks: SiteLink[] = [
    ...ACCOUNT_LINKS,
    ...(professional ? [{ href: "/espace-pro", label: "Espace pro" }] : []),
    ...(admin ? [{ href: "/admin", label: "Administration" }] : []),
  ];

  const positioning = dark
    ? "absolute inset-x-0 top-0 z-50"
    : placement === "fixed"
      ? "fixed inset-x-0 top-0 z-50"
      : "sticky top-0 z-40";

  return (
    <>
      <header
        ref={headerRef}
        data-site-header
        data-theme={theme}
        className={cn(
          positioning,
          dark
            ? "text-white"
            : "border-b border-border bg-white/95 text-foreground backdrop-blur supports-[backdrop-filter]:bg-white/90",
          className,
        )}
      >
        <div
          className={cn(
            "mx-auto flex items-center gap-3 px-4 sm:px-6",
            dark ? "h-[4.25rem] max-w-[90rem] lg:px-16" : "min-h-16 max-w-[96rem] lg:px-8",
          )}
        >
          <HeaderLogo dark={dark} showTagline={!dark && !center} />
          {center ? <div className="hidden min-w-0 max-w-md flex-1 lg:flex">{center}</div> : null}

          <nav
            aria-label="Navigation principale"
            className={cn(
              "hidden items-center gap-1 lg:flex",
              center ? "" : "flex-1 justify-center",
              dark && "flex-1 justify-end gap-6",
            )}
          >
            {SITE_NAV_LINKS.map((link) => (
              <HeaderNavLink
                key={link.href}
                link={link}
                active={isActive(pathname, link.href)}
                dark={dark}
              />
            ))}
          </nav>

          <div className={cn("hidden items-center gap-2 lg:flex", center && "ml-auto")}>
            {signedIn ? (
              <>
                <AlertNotificationCenter />
                <Suspense fallback={<AccountMenuPlaceholder dark={dark} />}>
                  <AccountMenu links={accountLinks} dark={dark} />
                </Suspense>
              </>
            ) : (
              <>
                <Link href="/login" className={cn(buttonBase, dark ? darkGhost : lightGhost)}>
                  Connexion
                </Link>
                {dark ? null : (
                  <Link href="/login?mode=investor" className={cn(buttonBase, goldButton)}>
                    Créer un compte
                  </Link>
                )}
              </>
            )}
          </div>

          <button
            ref={menuButtonRef}
            type="button"
            aria-label="Ouvrir le menu"
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? "site-mobile-navigation" : undefined}
            onClick={() => setMenuOpen(true)}
            className={cn(
              "ml-auto inline-grid size-11 shrink-0 cursor-pointer place-items-center rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold lg:hidden",
              dark
                ? "border-white/40 bg-brand-navy/50 text-white"
                : "border-border bg-white text-foreground",
            )}
          >
            <Menu className="size-5" aria-hidden />
          </button>
          <MobileMenuDialog
            open={menuOpen}
            onOpenChange={setMenuOpen}
            triggerRef={menuButtonRef}
            signedIn={signedIn}
            accountLinks={accountLinks}
            pathname={pathname}
          />
        </div>
        {belowBar}
      </header>
      {placement === "fixed" && !dark ? <div className="h-16" aria-hidden /> : null}
    </>
  );
}

function HeaderNavLink({ link, active, dark }: { link: SiteLink; active: boolean; dark: boolean }) {
  return (
    <Link
      href={link.href}
      prefetch={linkPrefetch(link.href)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-md px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold",
        dark
          ? "px-0 font-display text-xl font-medium text-white/95 hover:text-gold-light"
          : active
            ? "bg-gold/10 text-gold-text"
            : "text-foreground hover:bg-gold/10 hover:text-gold-text",
      )}
    >
      {link.label}
    </Link>
  );
}

/** Même bouton que « Mon compte », le temps que le menu (Radix Popover) se charge. */
function AccountMenuPlaceholder({ dark }: { dark: boolean }) {
  return (
    <button type="button" aria-busy className={cn(buttonBase, dark ? darkGhost : lightGhost)}>
      Mon compte
      <ChevronDown className="size-4" aria-hidden />
    </button>
  );
}
