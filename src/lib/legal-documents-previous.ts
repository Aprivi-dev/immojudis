import {
  FLOOD_LEGAL_EFFECTIVE_DATE,
  FREE_UNLOCK_EFFECTIVE_DATE,
  FULL_SALE_UNLOCK_EFFECTIVE_DATE,
  PEPITE_LEGAL_EFFECTIVE_DATE,
  PEPITE_TERMS_EFFECTIVE_DATE,
  PRIVACY_ANTHROPIC_ALL_AI_EFFECTIVE_DATE,
  PRIVACY_ANTHROPIC_EFFECTIVE_DATE,
  PRIVACY_AUTOPILOT_EFFECTIVE_DATE,
  PRIVACY_COMPLETION_EFFECTIVE_DATE,
  PRIVACY_COURT_REGISTRY_EFFECTIVE_DATE,
  PRIVACY_EMAIL_LOG_EFFECTIVE_DATE,
  PRIVACY_PROFESSIONALS_EFFECTIVE_DATE,
  PRIVACY_UNROUTED_MESSAGES_EFFECTIVE_DATE,
  SALE_PURCHASE_TERMS_EFFECTIVE_DATE,
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
    /** Versions plus récentes que la précédente mais déjà remplacées, archivées elles aussi. */
    earlier: [
      {
        version: "2026-11-15.2",
        sha256: "37905b0d0a391ab052c2d749d91a319dada4b32079357e3a3996bbc58205d2a7",
        effectiveDate: FULL_SALE_UNLOCK_EFFECTIVE_DATE,
        applicableUntil: SALE_PURCHASE_TERMS_EFFECTIVE_DATE,
        archive: "docs/legal-archives/conditions-generales-2026-11-15.2.tsx.txt",
      },
      {
        version: "2026-11-15.1",
        sha256: "52e3b866e3de65f04d363e72353491309a65c14c0e2c0b540a73d8f92df6c32b",
        effectiveDate: FREE_UNLOCK_EFFECTIVE_DATE,
        applicableUntil: FULL_SALE_UNLOCK_EFFECTIVE_DATE,
        archive: "docs/legal-archives/conditions-generales-2026-11-15.1.tsx.txt",
      },
      {
        version: "2026-11-10.1",
        sha256: "6b54cc1fe9be8f1a4879f691aba512e1505fb19bbff27516be841ba9f38d8fbc",
        effectiveDate: "10 novembre 2026",
        applicableUntil: FREE_UNLOCK_EFFECTIVE_DATE,
        archive: "docs/legal-archives/conditions-generales-2026-11-10.1.tsx.txt",
      },
      {
        version: "2026-10-26.1",
        sha256: "745ef0eacc7edc8dd02a63e36f6a0f0f9a18b07eeef2644abec806d4b0fd83e0",
        effectiveDate: PEPITE_LEGAL_EFFECTIVE_DATE,
        applicableUntil: PEPITE_TERMS_EFFECTIVE_DATE,
        archive: "docs/legal-archives/conditions-generales-2026-10-26.1.tsx.txt",
      },
    ],
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
    version: "2026-11-22.1",
    sha256: "c0888b3bb2dd66578c853b9bf634101906393c804eb1785e55d63755d3c08f15",
    effectiveDate: PRIVACY_ANTHROPIC_ALL_AI_EFFECTIVE_DATE,
    applicableUntil: PRIVACY_AUTOPILOT_EFFECTIVE_DATE,
    archive: "docs/legal-archives/privacy-2026-11-22.1.tsx.txt",
    /** Versions plus anciennes, archivées elles aussi. */
    earlier: [
      {
        version: "2026-11-21.1",
        sha256: "70a711a98758935dfe01b43178fb9855181bb4297bb612caf071240b847bfecd",
        effectiveDate: PRIVACY_ANTHROPIC_EFFECTIVE_DATE,
        applicableUntil: PRIVACY_ANTHROPIC_ALL_AI_EFFECTIVE_DATE,
        archive: "docs/legal-archives/privacy-2026-11-21.1.tsx.txt",
      },
      {
        version: "2026-11-15.1",
        sha256: "d544cf330804d9762de6d26d0e849e5cd9c1b7c0fc5accc75db96f535c9f3531",
        effectiveDate: FREE_UNLOCK_EFFECTIVE_DATE,
        applicableUntil: PRIVACY_ANTHROPIC_EFFECTIVE_DATE,
        archive: "docs/legal-archives/privacy-2026-11-15.1.tsx.txt",
      },
      {
        version: "2026-11-14.1",
        sha256: "19f625fc11fdc071f28918abcb74d8d52ef2194044967ae0e10449e70d2bea25",
        effectiveDate: PRIVACY_PROFESSIONALS_EFFECTIVE_DATE,
        applicableUntil: FREE_UNLOCK_EFFECTIVE_DATE,
        archive: "docs/legal-archives/privacy-2026-11-14.1.tsx.txt",
      },
      {
        version: "2026-11-01.3",
        sha256: "7bafa3d9a9cfed003fc49c50eb2759ceef8f8b6aa395e157538fe245b5cd6824",
        effectiveDate: PRIVACY_EMAIL_LOG_EFFECTIVE_DATE,
        applicableUntil: PRIVACY_PROFESSIONALS_EFFECTIVE_DATE,
        archive: "docs/legal-archives/privacy-2026-11-01.3.tsx.txt",
      },
      {
        version: "2026-11-01.2",
        sha256: "5ae544af26146742c9be3bc585baa596397425c098addf38914c2b6da42c2e6b",
        effectiveDate: PRIVACY_UNROUTED_MESSAGES_EFFECTIVE_DATE,
        applicableUntil: PRIVACY_EMAIL_LOG_EFFECTIVE_DATE,
        archive: "docs/legal-archives/privacy-2026-11-01.2.tsx.txt",
      },
      {
        version: "2026-11-01.1",
        sha256: "45fa8eb7d62a3a19333a88516fdcfff4e1678a288f4eab7b9b3d07773c5d18b9",
        effectiveDate: PRIVACY_COURT_REGISTRY_EFFECTIVE_DATE,
        applicableUntil: PRIVACY_UNROUTED_MESSAGES_EFFECTIVE_DATE,
        archive: "docs/legal-archives/privacy-2026-11-01.1.tsx.txt",
      },
      {
        version: "2026-10-31.1",
        sha256: "bed0e6a032d3131b0041641d810eeda53a2a27b27b080e3f6a5b10c9b29891d5",
        effectiveDate: PRIVACY_COMPLETION_EFFECTIVE_DATE,
        applicableUntil: PRIVACY_COURT_REGISTRY_EFFECTIVE_DATE,
        archive: "docs/legal-archives/privacy-2026-10-31.1.tsx.txt",
      },
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
