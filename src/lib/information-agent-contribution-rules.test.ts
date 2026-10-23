import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { submitContributionSchema } from "./information-agent-contribution";
import {
  CONTRIBUTION_FIELD_MESSAGES,
  CONTRIBUTION_LIMITS,
  isValidContributionEmail,
  validateContributionDraft,
  type ContributionDraft,
} from "./information-agent-contribution-rules";
import {
  contributionErrorResponse,
  contributionFieldErrorFromZod,
} from "./information-agent-contribution-route-error";
import { InformationAgentContributionError } from "./information-agent-contribution";

const VALID: ContributionDraft = {
  senderName: "Cabinet Dupont",
  senderEmail: "cabinet@example.test",
  note: "La visite est possible sur rendez-vous.",
  links: ["https://example.test/plan"],
  fileCount: 0,
  authorizedToTransmit: true,
};

/** Le contenu que le formulaire enverrait, tel que le serveur le valide. */
function serverAccepts(draft: ContributionDraft): boolean {
  return submitContributionSchema.safeParse({
    token: "a".repeat(64),
    submissionId: "11111111-1111-4111-8111-111111111111",
    senderName: draft.senderName,
    senderEmail: draft.senderEmail,
    note: draft.note,
    externalLinks: draft.links,
    authorizedToTransmit: draft.authorizedToTransmit,
    files: [],
  }).success;
}

describe("règles du dépôt partagées entre le navigateur et le serveur", () => {
  it("accepte un dépôt valide, des deux côtés", () => {
    expect(validateContributionDraft(VALID)).toBeNull();
    expect(serverAccepts(VALID)).toBe(true);
  });

  it.each([
    [
      "nom d'un caractère",
      { senderName: "A" },
      "senderName",
      CONTRIBUTION_FIELD_MESSAGES.senderNameMissing,
    ],
    [
      "nom de 181 caractères",
      { senderName: "N".repeat(181) },
      "senderName",
      CONTRIBUTION_FIELD_MESSAGES.senderNameTooLong,
    ],
    [
      "email sans point",
      { senderEmail: "cabinet@example" },
      "senderEmail",
      CONTRIBUTION_FIELD_MESSAGES.senderEmailInvalid,
    ],
    [
      "email à une lettre de domaine",
      { senderEmail: "a@b.c" },
      "senderEmail",
      CONTRIBUTION_FIELD_MESSAGES.senderEmailInvalid,
    ],
    [
      "email avec deux points",
      { senderEmail: "a..b@example.test" },
      "senderEmail",
      CONTRIBUTION_FIELD_MESSAGES.senderEmailInvalid,
    ],
    [
      "email de plus de 320 caractères",
      { senderEmail: `${"a".repeat(320)}@example.test` },
      "senderEmail",
      CONTRIBUTION_FIELD_MESSAGES.senderEmailTooLong,
    ],
    [
      "réponse de 10 001 caractères",
      { note: "x".repeat(10_001) },
      "note",
      CONTRIBUTION_FIELD_MESSAGES.noteTooLong,
    ],
    [
      "six liens",
      { links: Array.from({ length: 6 }, (_, index) => `https://example.test/${index}`) },
      "externalLinks",
      CONTRIBUTION_FIELD_MESSAGES.linksTooMany,
    ],
    [
      "lien de 2 049 caractères",
      { links: [`https://example.test/${"a".repeat(2049 - 20)}`] },
      "externalLinks",
      CONTRIBUTION_FIELD_MESSAGES.linkTooLong,
    ],
    [
      "lien non http",
      { links: ["ftp://example.test/plan"] },
      "externalLinks",
      CONTRIBUTION_FIELD_MESSAGES.linkInvalid,
    ],
    [
      "lien avec identifiants",
      { links: ["https://user:mdp@example.test/"] },
      "externalLinks",
      CONTRIBUTION_FIELD_MESSAGES.linkInvalid,
    ],
    [
      "lien sans schéma",
      { links: ["example.test/plan"] },
      "externalLinks",
      CONTRIBUTION_FIELD_MESSAGES.linkInvalid,
    ],
    [
      "dépôt vide",
      { note: "", links: [], fileCount: 0 },
      "note",
      CONTRIBUTION_FIELD_MESSAGES.empty,
    ],
    [
      "attestation absente",
      { authorizedToTransmit: false },
      "authorizedToTransmit",
      CONTRIBUTION_FIELD_MESSAGES.authorizationMissing,
    ],
  ] as Array<[string, Partial<ContributionDraft>, string, string]>)(
    "refuse %s avec le champ et le message",
    (_label, change, field, message) => {
      expect(validateContributionDraft({ ...VALID, ...change })).toEqual({ field, message });
    },
  );

  it("n'accepte jamais, côté navigateur, ce que le serveur refuse", () => {
    const names = ["", "A", "Cabinet Dupont", "N".repeat(180), "N".repeat(181), "  Do  "];
    const emails = [
      "cabinet@example.test",
      "a@b.c",
      "a@b",
      "a b@example.test",
      ".a@example.test",
      "a..b@example.test",
      "a@-example.test",
      "prenom.nom+tag@sous.domaine.example.fr",
      "é@example.test",
      "a@example.t",
      `${"a".repeat(320)}@example.test`,
    ];
    const notes = ["", "ok", "x".repeat(10_000), "x".repeat(10_001)];
    const links = [
      [],
      ["https://example.test"],
      ["http://example.test/a?b=c"],
      ["ftp://example.test"],
      ["https://u:p@example.test"],
      [`https://example.test/${"a".repeat(2028)}`],
      [`https://example.test/${"a".repeat(2029)}`],
      Array.from({ length: 5 }, () => "https://example.test"),
      Array.from({ length: 6 }, () => "https://example.test"),
    ];
    let accepted = 0;
    for (const senderName of names) {
      for (const senderEmail of emails) {
        for (const note of notes) {
          for (const linkSet of links) {
            const draft: ContributionDraft = {
              ...VALID,
              senderName,
              senderEmail,
              note,
              links: linkSet,
              fileCount: 1,
            };
            if (validateContributionDraft(draft) === null) {
              accepted += 1;
              expect(serverAccepts(draft), JSON.stringify([senderName, senderEmail, linkSet])).toBe(
                true,
              );
            }
          }
        }
      }
    }
    expect(accepted).toBeGreaterThan(0);
  });

  it("applique la même expression d'email que zod", () => {
    for (const email of [
      "a@example.test",
      "a@b.c",
      "a@b",
      "x.y@z.fr",
      "x..y@z.fr",
      ".x@z.fr",
      "x@z-.fr",
      "x@-z.fr",
      "x y@z.fr",
      "x@z.f",
      "x'y@z.fr",
      "x+y@z.fr",
      "é@z.fr",
    ]) {
      expect(isValidContributionEmail(email), email).toBe(
        z.string().email().safeParse(email).success,
      );
    }
  });

  it("compte aussi le texte enregistré : réponse et liens ensemble", () => {
    const links = Array.from(
      { length: 5 },
      (_, index) => `https://example.test/${index}/${"a".repeat(1990)}`,
    );
    expect(validateContributionDraft({ ...VALID, note: "x".repeat(10_000), links })).toEqual({
      field: "note",
      message: CONTRIBUTION_FIELD_MESSAGES.bodyTooLong,
    });
    expect(CONTRIBUTION_LIMITS.bodyMax).toBe(16_000);
  });
});

describe("réponse d'erreur des routes de dépôt", () => {
  it("désigne le champ pour une erreur de validation du schéma", async () => {
    const parsed = submitContributionSchema.safeParse({
      token: "a".repeat(64),
      submissionId: "11111111-1111-4111-8111-111111111111",
      senderName: "Cabinet",
      senderEmail: "pas-un-email",
      note: "",
      externalLinks: [],
      authorizedToTransmit: true,
      files: [],
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(contributionFieldErrorFromZod(parsed.error)).toEqual({
      field: "senderEmail",
      message: CONTRIBUTION_FIELD_MESSAGES.senderEmailInvalid,
    });

    const response = contributionErrorResponse(parsed.error);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: CONTRIBUTION_FIELD_MESSAGES.senderEmailInvalid,
      field: "senderEmail",
    });
  });

  it("transmet le champ d'une erreur métier et ne journalise pas une erreur client", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = contributionErrorResponse(
      new InformationAgentContributionError("Message.", 400, "externalLinks"),
    );
    expect(await response.json()).toEqual({ error: "Message.", field: "externalLinks" });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("journalise une erreur serveur sans donnée personnelle et répond 500 sans champ", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = contributionErrorResponse(
      Object.assign(new Error("duplicate key (storage_path)=(dossier/portal/cabinet-dupont.pdf)"), {
        code: "23505",
      }),
      "contribution.submit",
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Service de dépôt indisponible." });
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("information-agent.contribution.submit");
    expect(line).toContain("23505");
    expect(line).not.toContain("dupont");
    log.mockRestore();
  });
});
