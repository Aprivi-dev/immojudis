"use client";

import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import Link from "next/link";
import { useAuth } from "@/hooks/use-auth";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import { LAUNCH_OFFER_SHORT_TEXT, LAUNCH_OFFER_VISITOR_TEXT } from "@/lib/launch-offer";
import { loginPathWithRedirect } from "@/lib/navigation";

/**
 * Essai gratuit à l'inscription au-dessus de la liste des ventes, pour un visiteur sans compte : une
 * seule bannière repliable avec les règles de l'essai (`src/lib/launch-offer.ts`) et un lien vers la
 * création du compte. Les cartes n'ont que la ligne courte `LISTING_LAUNCH_OFFER_LINE`. Un compte
 * connecté voit son offre dans Mon compte, pas cette invitation.
 *
 * Jamais rendue côté serveur : tant que l'état n'est pas lu (rendu serveur compris), seule une
 * hauteur est réservée, pour que la liste ne descende pas quand la bannière arrive ; la coupure de
 * l'offre doit se voir en moins de 60 s.
 */
export function LaunchOfferListBanner() {
  const { user } = useAuth();
  const { active, pending } = useLaunchOffer();
  if (user) return null;
  if (pending) {
    return (
      <div
        aria-hidden
        data-testid="launch-offer-list-banner-placeholder"
        className="mb-3 min-h-[3.75rem] sm:min-h-11"
      />
    );
  }
  if (!active) return null;
  return (
    <details
      data-testid="launch-offer-list-banner"
      className="group mb-3 rounded-lg border border-gold/30 bg-gold/10 text-sm text-brand-navy"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-2 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft">
        <span>{LAUNCH_OFFER_SHORT_TEXT}</span>
        <ChevronDown
          className="size-4 shrink-0 transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>
      <div className="px-4 pb-3 leading-relaxed">
        <p>{LAUNCH_OFFER_VISITOR_TEXT}</p>
        <Link
          href={loginPathWithRedirect("/sales")}
          className="mt-2 inline-block font-semibold underline underline-offset-4"
        >
          S’inscrire gratuitement
        </Link>
      </div>
    </details>
  );
}
