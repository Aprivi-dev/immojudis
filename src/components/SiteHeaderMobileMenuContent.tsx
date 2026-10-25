"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import dynamic from "next/dynamic";
import Link from "next/link";
import type { CSSProperties } from "react";
import LogOut from "lucide-react/dist/esm/icons/log-out.js";
import {
  buttonBase,
  HeaderLogo,
  isActive,
  lightGhost,
  MenuBars,
  primaryButton,
  SignupLink,
  SITE_HEADER_PILL_CLASSES,
} from "@/components/site-header-shared";
import { useAuth } from "@/hooks/use-auth";
import { useHasAnalysisAccess } from "@/hooks/use-has-analysis-access";
import { getSupabase } from "@/integrations/supabase/lazy";
import {
  SITE_INFO_LINKS,
  SITE_LEGAL_LINKS,
  SITE_NAV_LINKS,
  linkPrefetch,
  visibleAccountLinks,
  type AccountLink,
  type SiteLink,
} from "@/lib/navigation";
import { cn } from "@/lib/utils";

const AlertNotificationCenter = dynamic(() =>
  import("@/components/AlertNotificationCenter").then((module) => module.AlertNotificationCenter),
);

/**
 * Contenu du menu mobile plein écran, chargé à sa première ouverture (`SiteHeaderMobileMenu.tsx`) :
 * il ne pèse pas dans le JavaScript commun à toutes les pages.
 */
export function MobileMenu({
  signedIn,
  accountLinks,
  pathname,
  openNotifications,
  onNavigate,
}: {
  signedIn: boolean;
  accountLinks: AccountLink[];
  pathname: string | null;
  openNotifications: boolean;
  onNavigate: () => void;
}) {
  const { user } = useAuth();
  const shownAccountLinks = visibleAccountLinks(accountLinks, useHasAnalysisAccess(user?.id));
  // Rang d'arrivée de chaque lien, dans l'ordre de lecture (les derniers arrivent ensemble).
  let index = 0;
  const next = () => Math.min(index++, 12);
  return (
    <>
      {/* La pilule de l'en-tête, à la même place : même logo, même bouton d'inscription, et le X. */}
      <div className="flex justify-center px-4 pt-[calc(1.5rem+env(safe-area-inset-top,0px))]">
        <div className={cn(SITE_HEADER_PILL_CLASSES, "pointer-events-auto")}>
          <HeaderLogo onClick={onNavigate} />
          <div className="flex items-center gap-2">
            {signedIn ? null : <SignupLink onClick={onNavigate} />}
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                aria-label="Fermer le menu"
                className="inline-grid size-10 cursor-pointer place-items-center rounded-full transition-colors hover:bg-gold/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
              >
                <MenuBars variant="close" />
              </button>
            </DialogPrimitive.Close>
          </div>
        </div>
      </div>

      <nav
        aria-label="Navigation mobile"
        className="mx-auto flex w-full max-w-md flex-col gap-8 px-6 pb-8 pt-10"
      >
        <ul className="grid gap-2">
          {SITE_NAV_LINKS.map((link) => {
            const active = isActive(pathname, link.href);
            return (
              <li key={link.href} className="menu-reveal" style={revealStyle(next())}>
                <Link
                  href={link.href}
                  prefetch={linkPrefetch(link.href)}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex min-h-11 items-center rounded-md text-3xl font-bold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft",
                    active ? "text-gold-text" : "hover:text-gold-text",
                  )}
                >
                  {link.label}
                </Link>
              </li>
            );
          })}
        </ul>
        {signedIn ? (
          <MobileSection
            title="Mon espace"
            links={shownAccountLinks}
            pathname={pathname}
            onNavigate={onNavigate}
            next={next}
          />
        ) : null}
        <MobileSection
          title="Aide"
          links={SITE_INFO_LINKS}
          pathname={pathname}
          onNavigate={onNavigate}
          next={next}
        />
        <MobileSection
          title="Informations légales"
          links={SITE_LEGAL_LINKS}
          pathname={pathname}
          onNavigate={onNavigate}
          next={next}
          subtle
        />
      </nav>

      <div
        className="menu-reveal mx-auto mt-auto grid w-full max-w-md gap-2 px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))]"
        style={revealStyle(next())}
      >
        {signedIn ? (
          <>
            <AlertNotificationCenter mobile openOnMount={openNotifications} />
            <button
              type="button"
              onClick={() => {
                onNavigate();
                void getSupabase().then((supabase) => supabase.auth.signOut());
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
              className={cn(buttonBase, primaryButton, "w-full")}
            >
              Créer un compte
            </Link>
          </>
        )}
      </div>
    </>
  );
}

function revealStyle(index: number): CSSProperties {
  return { "--menu-index": index } as CSSProperties;
}

function MobileSection({
  title,
  links,
  pathname,
  onNavigate,
  next,
  subtle = false,
}: {
  title: string;
  links: readonly SiteLink[];
  pathname: string | null;
  onNavigate: () => void;
  next: () => number;
  subtle?: boolean;
}) {
  return (
    <div className="menu-reveal" style={revealStyle(next())}>
      <p className="pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <ul>
        {links.map((link) => {
          const active = isActive(pathname, link.href);
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                prefetch={linkPrefetch(link.href)}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center rounded-md font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft",
                  subtle ? "text-sm font-medium text-muted-foreground" : "text-lg",
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
