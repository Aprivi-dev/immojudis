"use client";

import * as PopoverPrimitive from "@radix-ui/react-popover";
import Link from "next/link";
import { useState } from "react";
import LogOut from "lucide-react/dist/esm/icons/log-out.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import { buttonBase, lightGhost } from "@/components/site-header-shared";
import { useAuth } from "@/hooks/use-auth";
import { useHasAnalysisAccess } from "@/hooks/use-has-analysis-access";
import { getSupabase } from "@/integrations/supabase/lazy";
import { visibleAccountLinks, type AccountLink } from "@/lib/navigation";
import { cn } from "@/lib/utils";

/** Menu « Mon compte » (personnes connectées) : Radix Popover n'est chargé que pour elles. */
export function AccountMenu({ links }: { links: AccountLink[] }) {
  const [open, setOpen] = useState(false);
  const { user } = useAuth();
  const shownLinks = visibleAccountLinks(links, useHasAnalysisAccess(user?.id));
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button type="button" className={cn(buttonBase, lightGhost)}>
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
            {shownLinks.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-md px-3 py-2.5 font-medium hover:bg-gold/10 hover:text-gold-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
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
              void getSupabase().then((supabase) => supabase.auth.signOut());
            }}
            className="mt-1 flex w-full cursor-pointer items-center gap-2 rounded-md border-t border-border px-3 py-2.5 text-left font-medium hover:bg-gold/10 hover:text-gold-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
          >
            <LogOut className="size-4" aria-hidden />
            Déconnexion
          </button>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
