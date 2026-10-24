"use client";

import Link from "next/link";
import { useAuth } from "@/hooks/use-auth";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import { freeAccessLine } from "@/lib/sale-unlocks";

/** « Gratuit, sans carte bancaire… », ou la mention de l'offre de lancement quand elle est active. */
export function HomeFreeAccessLine({ className }: { className?: string }) {
  const { user } = useAuth();
  const launchOffer = useLaunchOffer().active;
  return (
    <p className={className}>
      <Link href="/offres">{freeAccessLine({ launchOffer, signedIn: Boolean(user) })}</Link>
    </p>
  );
}
