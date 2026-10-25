"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePublicPathname } from "@/hooks/use-public-pathname";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import Menu from "lucide-react/dist/esm/icons/menu.js";
import {
  buttonBase,
  goldButton,
  HeaderLogo,
  isActive,
  lightGhost,
} from "@/components/site-header-shared";
import { MobileMenuDialog } from "@/components/SiteHeaderMobileMenu";
import { MOBILE_MENU_UNREAD_ID } from "@/components/mobile-menu-unread";
import { useAuth } from "@/hooks/use-auth";
import { getAccountType, isAdminAccount } from "@/lib/account";
import {
  ACCOUNT_LINKS,
  linkPrefetch,
  SITE_NAV_LINKS,
  type AccountLink,
  type SiteLink,
} from "@/lib/navigation";
import { isDesktopHeader, onOpenNotificationsRequest } from "@/lib/notification-center-events";
import { cn } from "@/lib/utils";

const AlertNotificationCenter = dynamic(() =>
  import("@/components/AlertNotificationCenter").then((module) => module.AlertNotificationCenter),
);

// Pastille de non-lus du bouton du menu mobile : chargée à part, comme la cloche, pour ne pas
// alourdir le JavaScript commun avec la requête des notifications.
const MobileMenuUnreadBadge = dynamic(() =>
  import("@/components/MobileMenuUnreadBadge").then((module) => module.MobileMenuUnreadBadge),
);

// Radix Popover (menu « Mon compte ») n'est chargé que pour une personne connectée. Radix Dialog
// (menu mobile) reste dans le JavaScript commun : d'autres pages l'importent aussi, et un import
// dynamique ici ferait copier le module dans chacun de leurs fichiers (mesuré : +30 Ko par copie).
const AccountMenu = lazy(() =>
  import("@/components/SiteHeaderAccountMenu").then((module) => ({ default: module.AccountMenu })),
);

type SiteHeaderPlacement = "fixed" | "sticky";

/**
 * Position et habillage de la barre (élément `<header>`), partagés avec l'en-tête de secours
 * (`NavigationFallback` de `providers.tsx`) : tant que le vrai en-tête n'est pas là, la barre de
 * secours doit occuper exactement la même place, sinon la page bouge quand il arrive.
 */
export function siteHeaderClasses(placement: SiteHeaderPlacement): string {
  return cn(
    placement === "fixed" ? "fixed inset-x-0 top-0 z-50" : "sticky top-0 z-40",
    "border-b border-border bg-white/95 text-foreground backdrop-blur supports-[backdrop-filter]:bg-white/90",
  );
}

/** Rangée de la barre (logo, navigation) : même largeur et même hauteur que l'en-tête réel. */
export const SITE_HEADER_BAR_CLASSES =
  "mx-auto flex min-h-16 max-w-[96rem] items-center gap-3 px-4 sm:px-6 lg:px-8";

/** Vrai quand l'en-tête, fixé en haut de l'écran, laisse dans la page un espace de sa hauteur (h-16). */
export function siteHeaderReservesHeight(placement: SiteHeaderPlacement): boolean {
  return placement === "fixed";
}

type SiteHeaderProps = {
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
  placement = "fixed",
  center,
  belowBar,
  className,
  headerRef,
}: SiteHeaderProps) {
  const pathname = usePublicPathname();
  const { user, profile, loading } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  /** Le menu mobile a été ouvert pour montrer les notifications (action « Voir » d'un message). */
  const [notificationsRequested, setNotificationsRequested] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const signedIn = !loading && Boolean(user);
  const admin = isAdminAccount(user, profile);
  const professional = admin || getAccountType(user, profile) === "b2b";

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) setNotificationsRequested(false);
  }, [menuOpen]);

  // Sous « lg », la cloche n'existe que dans le menu mobile : on l'ouvre avec ses notifications.
  useEffect(() => {
    if (!signedIn) return;
    return onOpenNotificationsRequest(() => {
      if (isDesktopHeader()) return;
      setNotificationsRequested(true);
      setMenuOpen(true);
    });
  }, [signedIn]);

  // Le menu « Mon compte » et le menu mobile retirent eux-mêmes les entrées qui dépendent de
  // l'offre du compte (« Mes ventes débloquées ») : la lecture de l'offre n'est faite qu'à leur
  // ouverture, pas à chaque page.
  const accountLinks: AccountLink[] = [
    ...ACCOUNT_LINKS,
    ...(professional ? [{ href: "/espace-pro", label: "Espace pro" }] : []),
    ...(admin ? [{ href: "/admin", label: "Administration" }] : []),
  ];

  return (
    <>
      <header
        ref={headerRef}
        data-site-header
        className={cn(siteHeaderClasses(placement), className)}
      >
        <div className={SITE_HEADER_BAR_CLASSES}>
          <HeaderLogo showTagline={!center} />
          {center ? <div className="hidden min-w-0 max-w-md flex-1 lg:flex">{center}</div> : null}

          <nav
            aria-label="Navigation principale"
            className={cn(
              "hidden items-center gap-1 lg:flex",
              center ? "" : "flex-1 justify-center",
            )}
          >
            {SITE_NAV_LINKS.map((link) => (
              <HeaderNavLink key={link.href} link={link} active={isActive(pathname, link.href)} />
            ))}
          </nav>

          <div className={cn("hidden items-center gap-2 lg:flex", center && "ml-auto")}>
            {signedIn ? (
              <>
                <AlertNotificationCenter />
                <Suspense fallback={<AccountMenuPlaceholder />}>
                  <AccountMenu links={accountLinks} />
                </Suspense>
              </>
            ) : (
              <>
                <Link href="/login" className={cn(buttonBase, lightGhost)}>
                  Connexion
                </Link>
                <Link href="/login?mode=investor" className={cn(buttonBase, goldButton)}>
                  Créer un compte
                </Link>
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
            aria-describedby={signedIn ? MOBILE_MENU_UNREAD_ID : undefined}
            onClick={() => setMenuOpen(true)}
            className="relative ml-auto inline-grid size-11 shrink-0 cursor-pointer place-items-center rounded-md border border-border bg-white text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft lg:hidden"
          >
            <Menu className="size-5" aria-hidden />
            {signedIn ? <MobileMenuUnreadBadge /> : null}
          </button>
          <MobileMenuDialog
            open={menuOpen}
            onOpenChange={setMenuOpen}
            triggerRef={menuButtonRef}
            signedIn={signedIn}
            accountLinks={accountLinks}
            pathname={pathname}
            openNotifications={notificationsRequested}
          />
        </div>
        {belowBar}
      </header>
      {siteHeaderReservesHeight(placement) ? <div className="h-16" aria-hidden /> : null}
    </>
  );
}

function HeaderNavLink({ link, active }: { link: SiteLink; active: boolean }) {
  return (
    <Link
      href={link.href}
      prefetch={linkPrefetch(link.href)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-md px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft",
        active
          ? "bg-gold/10 text-gold-text"
          : "text-foreground hover:bg-gold/10 hover:text-gold-text",
      )}
    >
      {link.label}
    </Link>
  );
}

/** Même bouton que « Mon compte », le temps que le menu (Radix Popover) se charge. */
function AccountMenuPlaceholder() {
  return (
    <button type="button" aria-busy className={cn(buttonBase, lightGhost)}>
      Mon compte
      <ChevronDown className="size-4" aria-hidden />
    </button>
  );
}
