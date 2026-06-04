import { cn } from "@/lib/utils";

const BRAND_MARK = "/brand/owl-mark.png";

type BrandLogoProps = {
  className?: string;
  markClassName?: string;
  textClassName?: string;
  showTagline?: boolean;
};

export function BrandLogo({
  className,
  markClassName,
  textClassName,
  showTagline = false,
}: BrandLogoProps) {
  return (
    <span className={cn("inline-flex items-center gap-3", className)}>
      <img
        src={BRAND_MARK}
        alt=""
        className={cn("h-10 w-10 shrink-0 object-contain", markClassName)}
      />
      <span className="min-w-0">
        <span
          className={cn(
            "block font-sans text-base font-semibold uppercase leading-none text-foreground",
            textClassName,
          )}
        >
          Immojudis
        </span>
        {showTagline ? (
          <span className="mt-1 block text-xs font-medium leading-tight text-[var(--gold)]">
            Ventes aux enchères immobilières judiciaires
          </span>
        ) : null}
      </span>
    </span>
  );
}
