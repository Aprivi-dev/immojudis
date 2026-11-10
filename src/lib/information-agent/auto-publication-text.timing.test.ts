import { describe, expect, it } from "vitest";
import {
  AUTO_PUBLICATION_MAX_ANALYZED_TEXT_CHARS,
  decideAutoPublication,
  type AutoPublicationInput,
} from "./auto-publication-policy";
import { mentionsDoNotPublish, namesPrivatePerson } from "./auto-publication-text";

/**
 * Durée des détecteurs sur des entrées hostiles de 100 000 caractères (le texte vient du corps d'un email
 * reçu) : chacun doit rester linéaire. Plafond de 200 ms par appel, large pour une machine de CI chargée.
 */
const SIZE = 100_000;
const LIMIT_MS = 200;

function fill(unit: string, suffix = "") {
  return (
    unit.repeat(Math.ceil((SIZE - suffix.length) / unit.length)).slice(0, SIZE - suffix.length) +
    suffix
  );
}

const HOSTILE: Array<[string, string]> = [
  ["tabulations", fill("\t", "x")],
  ["espaces", fill(" ", "x")],
  ["« ne pas » répété", fill("ne pas ")],
  ["« M. » répété", fill("M. ")],
  ["« m » minuscule répété", fill("m ")],
  ["lettres isolées séparées par des espaces", fill("a ")],
  ["césures répétées", fill("a-")],
  ["rôle suivi de 100 000 espaces", `locataire${fill(" ", "x").slice(9)}`],
  ["rôle suivi de 100 000 tabulations", `débiteur${fill("\t", "x").slice(8)}`],
  ["rôle et qualificatifs répétés", fill("saisi saisi : ")],
  ["« garder » répété", fill("garder ")],
  ["séparateurs mêlés après un rôle", `occupant${fill(" ,\t:", "x").slice(8)}`],
];

function elapsed(run: () => unknown): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

describe("détecteurs de texte : durée linéaire sur des entrées hostiles", () => {
  it.each(HOSTILE)("ne pas publier : %s", (_label, text) => {
    expect(text.length).toBe(SIZE);
    expect(elapsed(() => mentionsDoNotPublish(text))).toBeLessThan(LIMIT_MS);
  });

  it.each(HOSTILE)("nom de particulier : %s", (_label, text) => {
    expect(elapsed(() => namesPrivatePerson(text))).toBeLessThan(LIMIT_MS);
  });
});

describe("plafond de taille du texte analysé", () => {
  const base: AutoPublicationInput = {
    candidate: {
      factKey: "surface_m2",
      status: "pending",
      evidenceAssetId: null,
      reviewedBy: null,
      proposedValue: { value: 54 },
      metadata: { semantic_agreement: true, semantic_extraction_method: "semantic_evidence_v3" },
    },
    message: {
      direction: "inbound",
      receivedAt: "2026-11-03T10:00:00.000Z",
      subject: "Re: demande",
      bodyText: "La surface habitable est de 54 m².",
      metadata: {
        imported_manually: false,
        sender_matches_recipient: true,
        sender_authentication: { dkim: "pass", dmarc: "pass" },
        inbound_processing: { status: "completed" },
      },
    },
    informationCase: {
      sentAt: "2026-11-01T09:00:00.000Z",
      recipientKind: "source_lawyer",
      status: "replied",
    },
    sale: {
      propertyType: "apartment",
      surfaceM2: null,
      appSurfaceM2: null,
      habitableSurfaceM2: null,
      carrezSurfaceM2: null,
      appSurfaceKind: null,
      surfaceScope: null,
      landSurfaceM2: null,
      roomsCount: null,
    },
    otherCandidatesForKey: 0,
    otherValuesForSale: 0,
    laterMessages: [],
    fieldFilledInSimulation: false,
  };

  it("un corps au-delà du plafond n'est pas analysé : relecture, jamais tronqué en silence", () => {
    const decision = decideAutoPublication({
      ...base,
      message: {
        ...base.message!,
        bodyText: `La surface habitable est de 54 m². ${" ".repeat(AUTO_PUBLICATION_MAX_ANALYZED_TEXT_CHARS)}`,
      },
    });
    expect(decision.outcome).toBe("review");
    expect(decision.reasons).toContain("input_unreadable");
  });

  it("un message postérieur au-delà du plafond : relecture", () => {
    const decision = decideAutoPublication({
      ...base,
      laterMessages: [
        {
          subject: null,
          bodyText: "a".repeat(AUTO_PUBLICATION_MAX_ANALYZED_TEXT_CHARS + 1),
          metadata: { inbound_processing: { status: "completed" } },
        },
      ],
    });
    expect(decision.reasons).toContain("input_unreadable");
  });

  it("un corps juste sous le plafond est analysé normalement, en temps borné", () => {
    const text = `La surface habitable est de 54 m².${" \t".repeat(90_000)}`;
    let decision: ReturnType<typeof decideAutoPublication> | undefined;
    const duration = elapsed(() => {
      decision = decideAutoPublication({ ...base, message: { ...base.message!, bodyText: text } });
    });
    expect(decision).toEqual({ outcome: "would_publish", reasons: [] });
    expect(duration).toBeLessThan(1_000);
  });
});
