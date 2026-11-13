import type { PilotDraft } from "@/lib/professional-pilots";

export const SALE_WORKSPACE_STATUSES = [
  "watching",
  "reviewing",
  "bidding",
  "won",
  "lost",
  "archived",
] as const;

export type SaleWorkspaceStatus = (typeof SALE_WORKSPACE_STATUSES)[number];

export const SALE_WORKSPACE_STATUS_LABELS: Record<SaleWorkspaceStatus, string> = {
  watching: "À surveiller",
  reviewing: "Analyse en cours",
  bidding: "Je prépare mon enchère",
  won: "Remporté",
  lost: "Non remporté",
  archived: "Archivé",
};

export const DEFAULT_WORKSPACE_NOTES = {
  general: "",
  occupation: "",
  works: "",
  market: "",
  privateMode: true,
};

export type SaleWorkspacePrivateNotes = typeof DEFAULT_WORKSPACE_NOTES & {
  professionalDossier?: PilotDraft;
};

export type SaleWorkspaceChecklist = Record<string, boolean>;

export const DOCUMENT_REVIEW_STATUSES = [
  "todo",
  "reviewing",
  "reviewed",
  "question",
  "blocked",
] as const;

export type SaleWorkspaceDocumentReviewStatus = (typeof DOCUMENT_REVIEW_STATUSES)[number];

export type SaleWorkspaceDocumentReview = {
  status: SaleWorkspaceDocumentReviewStatus;
  note: string;
  question: string;
  priority: boolean;
  reviewedAt: string | null;
  documentLabel: string | null;
  documentType: string | null;
  documentUrl: string | null;
  readPages: Record<string, boolean>;
  highlightedExcerpt: string | null;
};

export type SaleWorkspaceDocumentReviews = Record<string, SaleWorkspaceDocumentReview>;

export const DEFAULT_DOCUMENT_REVIEW: SaleWorkspaceDocumentReview = {
  status: "todo",
  note: "",
  question: "",
  priority: false,
  reviewedAt: null,
  documentLabel: null,
  documentType: null,
  documentUrl: null,
  readPages: {},
  highlightedExcerpt: null,
};

export const DEFAULT_SALE_CHECKLIST = [
  "Relire le cahier des conditions de vente",
  "Vérifier l'occupation",
  "Confirmer les diagnostics",
  "Chiffrer les travaux",
  "Valider le financement",
  "Transmettre les consignes à l'avocat",
] as const;
