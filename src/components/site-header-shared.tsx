import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { cn } from "@/lib/utils";

/** Éléments communs à l'en-tête et aux menus qu'il charge à la demande. */

export function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Barre flottante en pilule des autres pages (décision du 25/10/2026) : fixée à 24 px du haut,
 * centrée, à la largeur de son contenu, en verre dépoli. Partagée avec l'en-tête de secours
 * (`NavigationFallback` de `providers.tsx`) et le menu mobile, qui la reproduisent à la même place.
 */
export const SITE_HEADER_PILL_SHELL_CLASSES =
  "pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-[calc(1.5rem+env(safe-area-inset-top,0px))]";
export const SITE_HEADER_PILL_CLASSES =
  "pointer-events-auto flex w-max max-w-full min-w-0 items-center gap-4 rounded-full border border-border bg-white/75 py-2 pl-4 pr-2 text-foreground shadow-[0_8px_32px_-16px_rgb(19_34_56/0.25)] backdrop-blur-lg backdrop-saturate-150 lg:gap-6";
/**
 * Espace laissé dans la page sous la pilule : 24 px au-dessus, 58 px de pilule, 14 px de marge.
 * Quand la page suit avec son élément main, l'espace passe dans cet élément (règle
 * `[data-site-pill-spacer]` de `src/styles.css`), pour prendre le fond de la page et non celui du
 * site : sans cela, une page à fond blanc montrait une bande papier sous la pilule.
 */
export const SITE_HEADER_PILL_SPACER_CLASSES = "site-pill-spacer h-24";

export const buttonBase =
  "inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-full px-3 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft active:scale-[0.98]";
export const lightGhost =
  "border border-border bg-white text-foreground hover:border-gold hover:bg-gold/10";
/** Action principale de la barre : fond marine, marine adouci au survol. */
export const primaryButton = "bg-brand-navy text-white hover:bg-brand-navy-soft";
/** Action secondaire de la barre, sans cadre (« Connexion »). */
export const quietButton = "text-foreground hover:bg-gold/10 hover:text-gold-text";

/**
 * Les deux traits du bouton de menu. « burger » : deux traits parallèles, qui se croisent quand
 * `open` est vrai ; « close » : le X du menu ouvert, qui part des deux traits à son affichage.
 */
export function MenuBars({
  open = false,
  variant = "burger",
}: {
  open?: boolean;
  variant?: "burger" | "close";
}) {
  const crossed = variant === "close" || open;
  return (
    <span aria-hidden className="relative block size-4">
      <span
        className={cn(
          "menu-bar absolute left-0 h-0.5 w-4 rounded-full bg-current",
          variant === "close" ? "menu-bar-close-top" : crossed ? "top-[7px] rotate-45" : "top-1",
        )}
      />
      <span
        className={cn(
          "menu-bar absolute left-0 h-0.5 w-4 rounded-full bg-current",
          variant === "close"
            ? "menu-bar-close-bottom"
            : crossed
              ? "top-[7px] -rotate-45"
              : "top-[11px]",
        )}
      />
    </span>
  );
}

/** « S'inscrire », dans la pilule sous « lg » (en-tête et menu mobile ouvert). */
export function SignupLink({ onClick }: { onClick?: () => void }) {
  return (
    <Link href="/login?mode=investor" onClick={onClick} className={cn(buttonBase, primaryButton)}>
      S’inscrire
    </Link>
  );
}

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
        <BrandMark className="size-7" />
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
            Les enchères immobilières, en toute clarté
          </span>
        ) : null}
      </span>
    </Link>
  );
}
