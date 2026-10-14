import type { DocumentReadingResponse } from "@/lib/document-reading";
import { redactPersonalText } from "@/lib/personal-data-filter";

type FullReading = Extract<DocumentReadingResponse, { access: "full" }>;

/**
 * The points of a reading quote the case documents, which name occupants, tenants and debtors. Their
 * texts go through the personal-data filter (the one the collection and the shared reports use)
 * before they leave the server: a private individual is shown by role, as the privacy policy
 * states. Server side only, so that the filter never enters the browser bundle: the page imports
 * the types and helpers of `document-reading.ts`, not this module.
 */
export function redactReadingTexts(reading: FullReading): FullReading {
  return {
    ...reading,
    points: reading.points.map((point) => ({
      ...point,
      title: redactPersonalText(point.title),
      explanation: point.explanation === null ? null : redactPersonalText(point.explanation),
      quote: redactPersonalText(point.quote),
    })),
  };
}
