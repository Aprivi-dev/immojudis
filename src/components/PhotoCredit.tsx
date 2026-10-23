import type { PhotoCredit as PhotoCreditData } from "@/lib/photo-credit";
import { cn } from "@/lib/utils";

/**
 * « Photo : via [source] », avec un lien vers l'annonce d'origine quand on l'a. Source inconnue :
 * « Photo : source de l'annonce », sans lien.
 */
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
  if (!credit.label) {
    return (
      <span data-testid="photo-credit" className={className}>
        Photo : source de l&apos;annonce
      </span>
    );
  }
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

/**
 * Crédit d'un ensemble de photos (vignettes) : un seul crédit quand toutes viennent de la même
 * source, sinon « Photos : via A, B » avec une entrée par source, sans doublon.
 */
export function PhotoCredits({
  credits,
  className,
  linkClassName,
}: {
  credits: readonly (PhotoCreditData | null | undefined)[];
  className?: string;
  linkClassName?: string;
}) {
  const distinct: PhotoCreditData[] = [];
  for (const credit of credits) {
    if (!credit) continue;
    if (!distinct.some((item) => item.label === credit.label)) distinct.push(credit);
  }
  if (distinct.length === 0) return null;
  if (distinct.length === 1) {
    return <PhotoCredit credit={distinct[0]} className={className} linkClassName={linkClassName} />;
  }
  // Les sources nommées d'abord ; les photos de source inconnue forment une dernière entrée.
  const named = distinct.filter((item) => item.label);
  const unknown = distinct.some((item) => !item.label);
  return (
    <span data-testid="photo-credit" className={className}>
      Photos : via{" "}
      {named.map((item, index) => (
        <span key={item.label}>
          {index > 0 ? ", " : ""}
          {item.href ? (
            <a
              href={item.href}
              target="_blank"
              rel="nofollow noopener noreferrer"
              className={cn("underline underline-offset-2", linkClassName)}
            >
              {item.label}
            </a>
          ) : (
            item.label
          )}
        </span>
      ))}
      {unknown ? `${named.length ? ", " : ""}source de l'annonce` : null}
    </span>
  );
}
