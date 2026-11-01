import {
  FLOOD_LEGAL_EFFECTIVE_DATE,
  PEPITE_LEGAL_EFFECTIVE_DATE,
  PEPITE_TERMS_EFFECTIVE_DATE,
  PRIVACY_COMPLETION_EFFECTIVE_DATE,
  PRIVACY_COURT_REGISTRY_EFFECTIVE_DATE,
} from "@/lib/legal-documents";

// Module à part de `legal-documents.ts` : ces versions n'intéressent que les pages de textes
// juridiques (serveur) et les tests. Gardées dans `legal-documents.ts`, elles entraient dans le
// JavaScript client initial de toutes les pages (le pied de page importe ce module).

/**
 * Versions précédentes encore applicables ou à produire sur demande. Le code source exact de
 * chacune est archivé dans `docs/legal-archives/` (extension `.txt`, jamais modifié) et son
 * empreinte contrôlée par `legal-documents.test.ts`.
 */
export const PREVIOUS_LEGAL_DOCUMENTS = {
  terms: {
    version: "2026-10-25.1",
    sha256: "45b05a29108fc2c9b7637d92f9b5e8169971f6d4170ed09cfe3af9f7ae1de39c",
    effectiveDate: "25 octobre 2026",
    applicableUntil: PEPITE_TERMS_EFFECTIVE_DATE,
    archive: "docs/legal-archives/conditions-generales-2026-10-25.1.tsx.txt",
  },
  legal: {
    version: "2026-10-26.1",
    sha256: "d781161fc310eed0195caeccc50e5ef8df4d7dd986f419134baceaf8738a3b46",
    effectiveDate: PEPITE_LEGAL_EFFECTIVE_DATE,
    applicableUntil: FLOOD_LEGAL_EFFECTIVE_DATE,
    archive: "docs/legal-archives/legal-2026-10-26.1.tsx.txt",
    /** Versions plus anciennes, archivées elles aussi. */
    earlier: [
      {
        version: "2026-07-29.1",
        sha256: "c55e7cffefcf3ebc6e0807e3a234f8d155603e32344cd6ffc0f2478533538df9",
        effectiveDate: "29 juillet 2026",
        applicableUntil: PEPITE_LEGAL_EFFECTIVE_DATE,
        archive: "docs/legal-archives/legal-2026-07-29.1.tsx.txt",
      },
    ],
  },
  privacy: {
    version: "2026-10-31.1",
    sha256: "bed0e6a032d3131b0041641d810eeda53a2a27b27b080e3f6a5b10c9b29891d5",
    effectiveDate: PRIVACY_COMPLETION_EFFECTIVE_DATE,
    applicableUntil: PRIVACY_COURT_REGISTRY_EFFECTIVE_DATE,
    archive: "docs/legal-archives/privacy-2026-10-31.1.tsx.txt",
    /** Versions plus anciennes, archivées elles aussi. */
    earlier: [
      {
        version: "2026-10-26.1",
        sha256: "e3860fd8c06ffad5896fb6821d0abb4dd61a6d18bd9eb62afa1d25955fb532bb",
        effectiveDate: FLOOD_LEGAL_EFFECTIVE_DATE,
        applicableUntil: PRIVACY_COMPLETION_EFFECTIVE_DATE,
        archive: "docs/legal-archives/privacy-2026-10-26.1.tsx.txt",
      },
      {
        version: "2026-10-25.1",
        sha256: "f4eb47491d7ba15e83868156e2a084698d765166479c730b29c089a4f834bf60",
        effectiveDate: "25 octobre 2026",
        applicableUntil: FLOOD_LEGAL_EFFECTIVE_DATE,
        archive: "docs/legal-archives/privacy-2026-10-25.1.tsx.txt",
      },
    ],
  },
} as const;
