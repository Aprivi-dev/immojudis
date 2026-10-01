import type { ReactNode } from "react";
import { safeExternalHttpUrl } from "@/lib/external-url";
import {
  getAiReviewFieldResult,
  type AiReviewFieldKey,
  type AiReviewProjectionReadModel,
  type AiReviewRequestStatus,
} from "@/lib/ai-review-guard";

type AiReviewFieldProps = {
  fieldKey: AiReviewFieldKey;
  projections?: readonly AiReviewProjectionReadModel[] | null;
  children: ReactNode;
  fallback?: ReactNode;
  sourceName?: string | null;
  sourceUrl?: string | null;
  /** Authenticated read-model lifecycle. Loading and errors remain fail-closed. */
  reviewStatus?: AiReviewRequestStatus;
  /** Keep cards inside their existing navigation link while retaining source text. */
  showSourceLink?: boolean;
  className?: string;
};

/**
 * Displays a field only when its AI projection is publishable. Blocked fields
 * keep a short provenance trail so a reader can confirm the value at source.
 * The component intentionally accepts rows from a server adapter; it never
 * reads Supabase directly in the browser.
 */
export function AiReviewField({
  fieldKey,
  projections,
  children,
  fallback = "À confirmer",
  sourceName,
  sourceUrl,
  reviewStatus = "ready",
  showSourceLink = true,
  className,
}: AiReviewFieldProps) {
  const result = getAiReviewFieldResult(projections, fieldKey, reviewStatus);
  if (!result.blocked) {
    return (
      <span
        className={className}
        data-ai-review-field={fieldKey}
        data-ai-review-status={result.status}
      >
        {children}
      </span>
    );
  }

  const provenanceName = result.sourceName ?? cleanText(sourceName) ?? "Source officielle";
  const provenanceUrl = safeExternalHttpUrl(result.sourceUrl ?? sourceUrl);

  return (
    <span
      className={className}
      data-ai-review-field={fieldKey}
      data-ai-review-status="blocked"
      role="note"
      aria-label={`${String(fallback)}. ${result.reason ?? "Valeur à confirmer."}`}
      title={result.reason ?? undefined}
    >
      <span className="font-semibold">{fallback}</span>
      <span className="ml-1 text-xs font-normal text-muted-foreground">
        {showSourceLink && provenanceUrl ? (
          <a
            href={provenanceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            Source : {provenanceName}
            <span className="sr-only"> (nouvel onglet)</span>
          </a>
        ) : (
          <>Source : {provenanceName}</>
        )}
      </span>
    </span>
  );
}

function cleanText(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
