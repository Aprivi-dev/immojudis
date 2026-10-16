import type { PhotoCredit as PhotoCreditData } from "@/lib/photo-credit";
import { cn } from "@/lib/utils";

/** « Photo : via [source] », avec un lien vers l'annonce d'origine quand on l'a. */
export function PhotoCredit({
  credit,
  className,
  linkClassName,
}: {
  credit: PhotoCreditData | null | undefined;
  className?: string;
  linkClassName?: string;
}) {
  if (!credit) return null;
  return (
    <span data-testid="photo-credit" className={className}>
      Photo : via{" "}
      {credit.href ? (
        <a
          href={credit.href}
          target="_blank"
          rel="nofollow noopener noreferrer"
          className={cn("underline underline-offset-2", linkClassName)}
        >
          {credit.label}
        </a>
      ) : (
        credit.label
      )}
    </span>
  );
}
