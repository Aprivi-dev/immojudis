"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode, type Ref } from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import LogOut from "lucide-react/dist/esm/icons/log-out.js";
import Menu from "lucide-react/dist/esm/icons/menu.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { BrandMark } from "@/components/BrandLogo";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { getAccountType, isAdminAccount } from "@/lib/account";
import {
  ACCOUNT_LINKS,
  SITE_INFO_LINKS,
  SITE_LEGAL_LINKS,
  SITE_NAV_LINKS,
  type SiteLink,
} from "@/lib/navigation";
import { cn } from "@/lib/utils";

const AlertNotificationCenter = dynamic(() =>
  import("@/components/AlertNotificationCenter").then((module) => module.AlertNotificationCenter),
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

function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

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
                <AccountMenu links={accountLinks} dark={dark} />
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

          <DialogPrimitive.Root open={menuOpen} onOpenChange={setMenuOpen}>
            <DialogPrimitive.Trigger asChild>
              <button
                type="button"
                aria-label="Ouvrir le menu"
                className={cn(
                  "ml-auto inline-grid size-11 shrink-0 cursor-pointer place-items-center rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold lg:hidden",
                  dark
                    ? "border-white/40 bg-brand-navy/50 text-white"
                    : "border-border bg-white text-foreground",
                )}
              >
                <Menu className="size-5" aria-hidden />
              </button>
            </DialogPrimitive.Trigger>
            <DialogPrimitive.Portal>
              <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-brand-navy/30 backdrop-blur-sm" />
              <DialogPrimitive.Content
                id="site-mobile-navigation"
                aria-describedby={undefined}
                className="fixed inset-y-0 right-0 z-[61] flex w-[min(92vw,24rem)] flex-col overflow-y-auto border-l border-border bg-white text-foreground shadow-2xl outline-none"
              >
                <DialogPrimitive.Title className="sr-only">
                  Menu de navigation
                </DialogPrimitive.Title>
                <MobileMenu
                  signedIn={signedIn}
                  accountLinks={accountLinks}
                  pathname={pathname}
                  onNavigate={() => setMenuOpen(false)}
                />
              </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
          </DialogPrimitive.Root>
        </div>
        {belowBar}
      </header>
      {placement === "fixed" && !dark ? <div className="h-16" aria-hidden /> : null}
    </>
  );
}

const buttonBase =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold";
const lightGhost =
  "border border-border bg-white text-foreground hover:border-gold hover:bg-gold/10";
const darkGhost = "border border-gold-light text-gold-light hover:bg-white/10";
const goldButton = "bg-gold text-brand-navy hover:bg-gold-light";

export function HeaderLogo({
  dark = false,
  showTagline = false,
  onClick,
}: {
  dark?: boolean;
  showTagline?: boolean;
  onClick?: () => void;
}) {
  return (
    <Link
      href="/"
      onClick={onClick}
      aria-label="Immojudis, accueil"
      className="inline-flex shrink-0 items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
    >
      {dark ? null : <BrandMark variant="transparent" className="size-7" />}
      <span className="flex flex-col leading-none">
        <span
          className={cn(
            "font-display font-semibold tracking-tight",
            dark ? "text-[2.5rem] font-medium text-white" : "text-2xl text-foreground",
          )}
        >
          Immo<span className={dark ? "text-gold-light" : "text-gold-text"}>judis</span>
        </span>
        {showTagline ? (
          <span className="mt-1 hidden text-xs font-normal text-muted-foreground min-[480px]:block">
            Les ventes immobilières en toute clarté
          </span>
        ) : null}
      </span>
    </Link>
  );
}

function HeaderNavLink({ link, active, dark }: { link: SiteLink; active: boolean; dark: boolean }) {
  return (
    <Link
      href={link.href}
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

function AccountMenu({ links, dark }: { links: SiteLink[]; dark: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button type="button" className={cn(buttonBase, dark ? darkGhost : lightGhost)}>
          Mon compte
          <ChevronDown className="size-4" aria-hidden />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={8}
          className="z-[70] w-60 rounded-lg border border-border bg-white p-1.5 text-sm text-foreground shadow-xl outline-none"
        >
          <ul>
            {links.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-md px-3 py-2.5 font-medium hover:bg-gold/10 hover:text-gold-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              void supabase.auth.signOut();
            }}
            className="mt-1 flex w-full cursor-pointer items-center gap-2 rounded-md border-t border-border px-3 py-2.5 text-left font-medium hover:bg-gold/10 hover:text-gold-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
          >
            <LogOut className="size-4" aria-hidden />
            Déconnexion
          </button>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function MobileMenu({
  signedIn,
  accountLinks,
  pathname,
  onNavigate,
}: {
  signedIn: boolean;
  accountLinks: SiteLink[];
  pathname: string | null;
  onNavigate: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <HeaderLogo onClick={onNavigate} />
        <DialogPrimitive.Close asChild>
          <button
            type="button"
            aria-label="Fermer le menu"
            className="inline-grid size-11 cursor-pointer place-items-center rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
          >
            <X className="size-5" aria-hidden />
          </button>
        </DialogPrimitive.Close>
      </div>

      <nav aria-label="Navigation mobile" className="flex flex-col px-4 py-3">
        <MobileSection
          title="Parcourir"
          links={SITE_NAV_LINKS}
          pathname={pathname}
          onNavigate={onNavigate}
        />
        {signedIn ? (
          <MobileSection
            title="Mon espace"
            links={accountLinks}
            pathname={pathname}
            onNavigate={onNavigate}
          />
        ) : null}
        <MobileSection
          title="Aide"
          links={SITE_INFO_LINKS}
          pathname={pathname}
          onNavigate={onNavigate}
        />
        <MobileSection
          title="Informations légales"
          links={SITE_LEGAL_LINKS}
          pathname={pathname}
          onNavigate={onNavigate}
          subtle
        />
      </nav>

      <div className="mt-auto grid gap-2 border-t border-border bg-white p-4">
        {signedIn ? (
          <>
            <AlertNotificationCenter mobile />
            <button
              type="button"
              onClick={() => {
                onNavigate();
                void supabase.auth.signOut();
              }}
              className={cn(buttonBase, lightGhost, "w-full")}
            >
              <LogOut className="size-4" aria-hidden />
              Déconnexion
            </button>
          </>
        ) : (
          <>
            <Link
              href="/login"
              onClick={onNavigate}
              className={cn(buttonBase, lightGhost, "w-full")}
            >
              Connexion
            </Link>
            <Link
              href="/login?mode=investor"
              onClick={onNavigate}
              className={cn(buttonBase, goldButton, "w-full")}
            >
              Créer un compte
            </Link>
          </>
        )}
      </div>
    </>
  );
}

function MobileSection({
  title,
  links,
  pathname,
  onNavigate,
  subtle = false,
}: {
  title: string;
  links: readonly SiteLink[];
  pathname: string | null;
  onNavigate: () => void;
  subtle?: boolean;
}) {
  return (
    <div className="mb-3">
      <p className="px-1 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <ul>
        {links.map((link) => {
          const active = isActive(pathname, link.href);
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center rounded-md px-1 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold",
                  subtle ? "text-sm font-medium text-muted-foreground" : "text-base",
                  active ? "text-gold-text" : "hover:text-gold-text",
                )}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
