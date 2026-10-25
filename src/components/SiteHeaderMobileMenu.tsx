"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { lazy, Suspense, type RefObject } from "react";
import type { AccountLink } from "@/lib/navigation";

// Le contenu du menu (liens, notifications, déconnexion) n'est chargé qu'à la première ouverture :
// seul ce module l'importe, il ne peut donc pas être recopié dans d'autres fichiers.
const MobileMenu = lazy(() =>
  import("@/components/SiteHeaderMobileMenuContent").then((module) => ({
    default: module.MobileMenu,
  })),
);

/**
 * Menu mobile plein écran, en verre dépoli : il reprend la pilule de l'en-tête à la même place (le
 * bouton de menu y devient un X) et ses liens arrivent un à un. Radix Dialog n'est chargé qu'au
 * premier appui sur le bouton (ou à son survol / focus). Sans `Dialog.Trigger` dans ce sous-arbre,
 * la restitution du focus au bouton est faite ici.
 */
export function MobileMenuDialog({
  open,
  onOpenChange,
  triggerRef,
  signedIn,
  accountLinks,
  pathname,
  openNotifications = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  signedIn: boolean;
  accountLinks: AccountLink[];
  pathname: string | null;
  /** Ouvre aussi le panneau des notifications (action « Voir » d'un message). */
  openNotifications?: boolean;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          id="site-mobile-navigation"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
          className="menu-overlay fixed inset-0 z-[61] flex flex-col overflow-y-auto bg-background/85 text-foreground outline-none backdrop-blur-xl backdrop-saturate-150"
        >
          <DialogPrimitive.Title className="sr-only">Menu de navigation</DialogPrimitive.Title>
          <Suspense fallback={null}>
            <MobileMenu
              signedIn={signedIn}
              accountLinks={accountLinks}
              pathname={pathname}
              openNotifications={openNotifications}
              onNavigate={() => onOpenChange(false)}
            />
          </Suspense>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
