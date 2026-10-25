"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePublicPathname } from "@/hooks/use-public-pathname";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import {
  buttonBase,
  HeaderLogo,
  isActive,
  lightGhost,
  MenuBars,
  primaryButton,
  quietButton,
  SignupLink,
  SITE_HEADER_PILL_CLASSES,
  SITE_HEADER_PILL_SHELL_CLASSES,
  SITE_HEADER_PILL_SPACER_CLASSES,
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
 * Position et habillage de la barre pleine largeur (élément `<header>`) du catalogue (/sales), qui
 * porte la recherche et les filtres.
 */
export function siteHeaderClasses(placement: SiteHeaderPlacement): string {
  return cn(
    placement === "fixed" ? "fixed inset-x-0 top-0 z-50" : "sticky top-0 z-40",
    "border-b border-border bg-white/95 text-foreground backdrop-blur supports-[backdrop-filter]:bg-white/90",
  );
}

/** Rangée de la barre pleine largeur (logo, recherche, navigation). */
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

  const navLinks = SITE_NAV_LINKS.map((link) => (
    <HeaderNavLink key={link.href} link={link} active={isActive(pathname, link.href)} />
  ));
  const accountActions = signedIn ? (
    <>
      <AlertNotificationCenter />
      <Suspense fallback={<AccountMenuPlaceholder />}>
        <AccountMenu links={accountLinks} />
      </Suspense>
    </>
  ) : (
    <VisitorActions />
  );
  const menuButton = (
    <>
      <MenuButton
        buttonRef={menuButtonRef}
        open={menuOpen}
        signedIn={signedIn}
        onOpen={() => setMenuOpen(true)}
      />
      <MobileMenuDialog
        open={menuOpen}
        onOpenChange={setMenuOpen}
        triggerRef={menuButtonRef}
        signedIn={signedIn}
        accountLinks={accountLinks}
        pathname={pathname}
        openNotifications={notificationsRequested}
      />
    </>
  );

  // Le catalogue garde la barre pleine largeur : la recherche et les filtres y tiennent la place.
  if (center || belowBar) {
    return (
      <>
        <header
          ref={headerRef}
          data-site-header
          className={cn(siteHeaderClasses(placement), className)}
        >
          <div className={SITE_HEADER_BAR_CLASSES}>
            <HeaderLogo />
            {center ? <div className="hidden min-w-0 max-w-md flex-1 lg:flex">{center}</div> : null}
            <nav aria-label="Navigation principale" className="hidden items-center gap-1 lg:flex">
              {navLinks}
            </nav>
            <div className="ml-auto hidden items-center gap-2 lg:flex">{accountActions}</div>
            <div className="ml-auto lg:hidden">{menuButton}</div>
          </div>
          {belowBar}
        </header>
        {siteHeaderReservesHeight(placement) ? <div className="h-16" aria-hidden /> : null}
      </>
    );
  }

  return (
    <SitePill
      headerRef={headerRef}
      className={className}
      pathname={pathname}
      actions={accountActions}
      signup={!signedIn}
      menu={menuButton}
    />
  );
}

/**
 * La pilule elle-même (logo, navigation, actions ; sous « lg », inscription et bouton de menu),
 * partagée par l'en-tête et par son en-tête de secours, et l'espace qu'elle laisse dans la page.
 */
function SitePill({
  headerRef,
  className,
  pathname,
  actions,
  signup,
  menu,
}: {
  headerRef?: Ref<HTMLElement>;
  className?: string;
  pathname: string | null;
  actions: ReactNode;
  signup: boolean;
  menu: ReactNode;
}) {
  return (
    <>
      <header
        ref={headerRef}
        data-site-header
        className={cn(SITE_HEADER_PILL_SHELL_CLASSES, className)}
      >
        <div className={SITE_HEADER_PILL_CLASSES}>
          <HeaderLogo />
          <nav aria-label="Navigation principale" className="hidden items-center gap-1 lg:flex">
            {SITE_NAV_LINKS.map((link) => (
              <HeaderNavLink key={link.href} link={link} active={isActive(pathname, link.href)} />
            ))}
          </nav>
          <div className="hidden items-center gap-2 lg:flex">{actions}</div>
          <div className="flex items-center gap-2 lg:hidden">
            {signup ? <SignupLink /> : null}
            {menu}
          </div>
        </div>
      </header>
      <div data-site-pill-spacer className={SITE_HEADER_PILL_SPACER_CLASSES} aria-hidden />
    </>
  );
}

function VisitorActions() {
  return (
    <>
      <Link href="/login" className={cn(buttonBase, quietButton)}>
        Connexion
      </Link>
      <Link href="/login?mode=investor" className={cn(buttonBase, primaryButton)}>
        Créer un compte
      </Link>
    </>
  );
}

/**
 * Bouton du menu mobile : deux traits qui se croisent en X à l'ouverture (le menu plein écran
 * reprend la pilule à la même place, avec un X identique pour le fermer).
 */
function MenuButton({
  buttonRef,
  open,
  signedIn,
  onOpen,
}: {
  buttonRef: Ref<HTMLButtonElement>;
  open: boolean;
  signedIn: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label="Ouvrir le menu"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? "site-mobile-navigation" : undefined}
      aria-describedby={signedIn ? MOBILE_MENU_UNREAD_ID : undefined}
      onClick={onOpen}
      className="relative inline-grid size-10 shrink-0 cursor-pointer place-items-center rounded-full text-foreground transition-colors hover:bg-gold/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft lg:hidden"
    >
      <MenuBars open={open} />
      {signedIn ? <MobileMenuUnreadBadge /> : null}
    </button>
  );
}

/**
 * En-tête de secours, le temps que le vrai se charge : la même pilule, à la même place, avec les
 * liens et les actions d'un visiteur (le cas le plus fréquent), pour que la barre ne change ni de
 * place ni de largeur à l'arrivée du vrai en-tête.
 */
export function SitePillFallback() {
  return (
    <SitePill
      pathname={null}
      actions={<VisitorActions />}
      signup
      menu={
        <span className="inline-grid size-10 place-items-center" aria-hidden>
          <MenuBars />
        </span>
      }
    />
  );
}

function HeaderNavLink({ link, active }: { link: SiteLink; active: boolean }) {
  return (
    <Link
      href={link.href}
      prefetch={linkPrefetch(link.href)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-full px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft",
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
