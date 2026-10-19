"use client";

import Link from "next/link";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import { UnlockCallToAction } from "@/components/sale-detail/UnlockCallToAction";
import { useAnalysisCheckoutOpen } from "@/hooks/use-analysis-checkout-open";

const PRIMARY_LINK_CLASS =
  "inline-flex rounded-lg bg-gold px-4 py-3 text-sm font-semibold text-brand-navy hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2";
const SECONDARY_LINK_CLASS =
  "inline-flex min-h-11 items-center text-sm font-semibold text-gold-text underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2";

/** Decorative placeholders only: protected values are never rendered under the blur. */
export function PremiumFeaturePreview({
  title,
  description,
  labels,
  unlockOffer = false,
  compact = false,
}: {
  title: string;
  description: string;
  labels: readonly string[];
  /**
   * What the preview announces can also be opened by unlocking the sale (the title says « ou en
   * débloquant cette vente »): the main link then unlocks it, when the page has the unlock card.
   */
  unlockOffer?: boolean;
  /**
   * Une ligne au lieu de l'aperçu flouté : pour une fonction annoncée sous le contenu principal
   * (ex. le suivi des changements sous les favoris), sans lui voler la place.
   */
  compact?: boolean;
}) {
  const checkoutOpen = useAnalysisCheckoutOpen();
  if (compact) {
    return (
      <section
        className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-gold/25 bg-white px-4 py-3"
        aria-label={title}
      >
        <LockKeyhole aria-hidden className="h-4 w-4 shrink-0 text-gold-text" />
        <div className="min-w-0 flex-1 basis-64">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
          {checkoutOpen === false ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              L’offre Analyse n’est pas encore ouverte à la souscription.
            </p>
          ) : null}
        </div>
        <Link href="/offres" className={SECONDARY_LINK_CLASS}>
          Découvrir l’offre Analyse
        </Link>
      </section>
    );
  }
  return (
    <section
      className="overflow-hidden rounded-xl border border-gold/25 bg-white p-5 sm:p-6"
      aria-label={title}
    >
      <div className="mb-5 grid gap-3 sm:grid-cols-3" aria-hidden="true">
        {labels.map((label) => (
          <div key={label} className="rounded-lg border border-border bg-stone-50 p-4">
            <p className="text-xs text-muted-foreground">{label}</p>
            <div className="mt-3 select-none blur-[5px]">
              <div className="h-6 w-3/4 rounded bg-slate-300" />
              <div className="mt-3 h-2 w-full rounded bg-slate-200" />
              <div className="mt-2 h-2 w-2/3 rounded bg-slate-200" />
            </div>
          </div>
        ))}
      </div>
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gold-text">
        <LockKeyhole aria-hidden className="h-4 w-4" /> Offre Analyse
      </p>
      <h3 className="mt-2 font-display text-2xl text-foreground">{title}</h3>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      {checkoutOpen === true ? (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Pour un premier accès éligible : 7 jours d’essai gratuits avec carte bancaire, puis
          abonnement récurrent. Un compte ayant déjà utilisé l’essai souscrit directement.
          Résiliation depuis votre compte.
        </p>
      ) : checkoutOpen === false ? (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          L’offre Analyse n’est pas encore ouverte à la souscription.
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
        {unlockOffer ? (
          <UnlockCallToAction
            primaryClassName={PRIMARY_LINK_CLASS}
            secondaryClassName={SECONDARY_LINK_CLASS}
            messageClassName="basis-full text-sm font-medium text-foreground"
            withOpeningRequest
          />
        ) : (
          // Souscription fermée (ou état pas encore connu) : un lien discret, pas le bouton or d'un
          // achat qui n'existe pas encore. Le bouton or revient quand l'offre est vraiment ouverte.
          <Link
            href="/offres"
            className={checkoutOpen === true ? PRIMARY_LINK_CLASS : SECONDARY_LINK_CLASS}
          >
            Découvrir l’offre Analyse
          </Link>
        )}
        <Link href="/annonce-exemple" className={SECONDARY_LINK_CLASS}>
          Voir une analyse exemple
        </Link>
      </div>
    </section>
  );
}
