"use client";

import Link from "next/link";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import { useAuth } from "@/hooks/use-auth";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import { LAUNCH_OFFER_SHORT_TEXT } from "@/lib/launch-offer";
import { loginPathWithRedirect } from "@/lib/navigation";
import { FREE_ACCESS_LINE } from "@/lib/sale-unlocks";

/**
 * L'appel à l'inscription gratuite, sous la recherche (premier et dernier écran) : « Inscription
 * gratuite : 7 jours d'accès à l'offre Analyse… » pendant l'essai à l'inscription, sinon « Gratuit,
 * sans carte bancaire… ». Il mène à la création du compte. Rien pour un compte connecté. Les règles
 * de l'essai (début, durée, une fois par personne, retour à Découverte) sont écrites dans la carte
 * Analyse de la section des offres, sur la même page.
 */
export function HomeFreeAccessLine({ className }: { className?: string }) {
  const { user } = useAuth();
  const launchOffer = useLaunchOffer().active;
  if (user) return null;
  return (
    <p className={className}>
      <Link href={loginPathWithRedirect(undefined)} prefetch={false}>
        {launchOffer ? LAUNCH_OFFER_SHORT_TEXT : FREE_ACCESS_LINE}
      </Link>
    </p>
  );
}

/** Le bouton principal du premier écran pour un visiteur : créer son compte gratuit. */
export function HomeSignupButton({ className }: { className?: string }) {
  const { user } = useAuth();
  if (user) return null;
  return (
    <Link href={loginPathWithRedirect(undefined)} prefetch={false} className={className}>
      S’inscrire gratuitement <ArrowRight aria-hidden="true" size={17} />
    </Link>
  );
}
