"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import dynamic from "next/dynamic";
import Link from "next/link";
import type { RefObject } from "react";
import LogOut from "lucide-react/dist/esm/icons/log-out.js";
import X from "lucide-react/dist/esm/icons/x.js";
import {
  buttonBase,
  goldButton,
  HeaderLogo,
  isActive,
  lightGhost,
} from "@/components/site-header-shared";
import { getSupabase } from "@/integrations/supabase/lazy";
import {
  SITE_INFO_LINKS,
  SITE_LEGAL_LINKS,
  SITE_NAV_LINKS,
  linkPrefetch,
  type SiteLink,
} from "@/lib/navigation";
import { cn } from "@/lib/utils";

const AlertNotificationCenter = dynamic(() =>
  import("@/components/AlertNotificationCenter").then((module) => module.AlertNotificationCenter),
);

/**
 * Menu mobile : Radix Dialog n'est chargé qu'au premier appui sur le bouton (ou à son survol /
 * focus). Sans `Dialog.Trigger` dans ce sous-arbre, la restitution du focus au bouton est faite ici.
 */
export function MobileMenuDialog({
  open,
  onOpenChange,
  triggerRef,
  signedIn,
  accountLinks,
  pathname,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  signedIn: boolean;
  accountLinks: SiteLink[];
  pathname: string | null;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-brand-navy/30 backdrop-blur-sm" />
        <DialogPrimitive.Content
          id="site-mobile-navigation"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
          className="fixed inset-y-0 right-0 z-[61] flex w-[min(92vw,24rem)] flex-col overflow-y-auto border-l border-border bg-white text-foreground shadow-2xl outline-none"
        >
          <DialogPrimitive.Title className="sr-only">Menu de navigation</DialogPrimitive.Title>
          <MobileMenu
            signedIn={signedIn}
            accountLinks={accountLinks}
            pathname={pathname}
            onNavigate={() => onOpenChange(false)}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
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
                prefetch={linkPrefetch(link.href)}
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
