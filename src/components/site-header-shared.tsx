import Link from "next/link";
import { BrandMark } from "@/components/BrandLogo";

/** Éléments communs à l'en-tête et aux menus qu'il charge à la demande. */

export function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export const buttonBase =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft";
export const lightGhost =
  "border border-border bg-white text-foreground hover:border-gold hover:bg-gold/10";
export const goldButton = "bg-gold text-brand-navy hover:bg-gold-light";

export function HeaderLogo({
  showTagline = false,
  onClick,
}: {
  showTagline?: boolean;
  onClick?: () => void;
}) {
  return (
    <Link
      href="/"
      onClick={onClick}
      className="inline-flex shrink-0 items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
    >
      <span aria-hidden className="inline-flex">
        <BrandMark variant="transparent" className="size-7" />
      </span>
      <span className="flex flex-col leading-none">
        <span className="font-display text-2xl font-semibold tracking-tight text-foreground">
          Immo<span className="text-gold-text">judis</span>
          <span className="sr-only">, accueil</span>
        </span>
        {showTagline ? (
          <span
            aria-hidden
            className="mt-1 hidden text-xs font-normal text-muted-foreground min-[480px]:block"
          >
            Les ventes immobilières en toute clarté
          </span>
        ) : null}
      </span>
    </Link>
  );
}
