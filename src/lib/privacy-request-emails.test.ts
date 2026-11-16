import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_ERASURE_POLICY_TEXT,
  ACCOUNT_ERASURE_RETAINED_ROWS,
  buildPrivacyRequestAcknowledgementMessage,
  buildPrivacyRequestClosureMessage,
  buildPrivacyRequestOperatorMessage,
  PROFESSIONAL_ERASURE_KEPT_TEXT,
} from "./privacy-request-emails";

const envelope = {
  from: "Immojudis <compte@immojudis.test>",
  to: "client@example.test",
  appUrl: "https://immojudis.test",
};
const facts = {
  requestType: "erasure",
  submittedAt: "2026-11-15T09:00:00Z",
  dueAt: "2026-12-15T09:00:00Z",
  subjectKind: "account" as const,
};

/** Texte d'un fichier source, espaces et retours à la ligne ramenés à une espace (texte JSX coupé). */
function flatSource(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8").replace(/\s+/g, " ");
}

describe("emails de suivi d'une demande de droits", () => {
  it("cite la politique de confidentialité publiée mot pour mot (aucun texte inventé)", () => {
    const privacy = flatSource("src/routes/privacy.tsx");
    expect(privacy).toContain(ACCOUNT_ERASURE_POLICY_TEXT);
    for (const [purpose, retention] of ACCOUNT_ERASURE_RETAINED_ROWS) {
      expect(privacy).toContain(`purpose: "${purpose}"`);
      expect(privacy).toContain(retention);
    }
    expect(flatSource("src/app/api/information-agent/rights/route.ts")).toContain(
      PROFESSIONAL_ERASURE_KEPT_TEXT,
    );
  });

  it("à l'exploitation : nature, dates, lien vers Conformité ; jamais l'adresse ni le message", () => {
    const message = buildPrivacyRequestOperatorMessage(facts, {
      ...envelope,
      to: "proprietaire@immojudis.test",
    });
    expect(message.subject).toBe("[Immojudis] Nouvelle demande de droits : Effacement / compte");
    expect(message.text).toContain("Déposée le : 15 novembre 2026");
    expect(message.text).toContain("Échéance : 15 décembre 2026 (délai d’un mois)");
    expect(message.text).toContain("https://immojudis.test/admin/compliance");
    expect(message.html).toContain("https://immojudis.test/admin/compliance");
    expect(`${message.text}${message.html}`).not.toContain("client@example.test");
    expect(message.replyTo).toBeNull();
  });

  it("accusé de réception : type, date, échéance et suivi depuis Mes droits", () => {
    const message = buildPrivacyRequestAcknowledgementMessage(
      { ...facts, requestType: "contract_withdrawal", dueAt: "2026-11-29T09:00:00Z" },
      envelope,
    );
    expect(message.subject).toBe(
      "Nous avons bien reçu votre demande : Rétractation d’une commande",
    );
    expect(message.text).toContain("Échéance de réponse : 29 novembre 2026 (délai de 14 jours)");
    expect(message.text).toContain("https://immojudis.test/mes-droits");
    const professional = buildPrivacyRequestAcknowledgementMessage(
      { ...facts, subjectKind: "information_agent_professional" },
      envelope,
    );
    expect(professional.text).toContain("La réponse vous sera adressée à cette adresse email.");
    expect(professional.text).not.toContain("/mes-droits");
  });

  it("clôture d'un effacement : ce qui est effacé et ce qui est conservé, sans renvoi au compte", () => {
    const message = buildPrivacyRequestClosureMessage(
      facts,
      {
        status: "completed",
        closedAt: "2026-11-20T09:00:00Z",
        erasureExecuted: true,
        response: null,
      },
      envelope,
    );
    expect(message.subject).toBe("Votre demande a été traitée : Effacement / compte");
    expect(message.text).toContain(ACCOUNT_ERASURE_POLICY_TEXT);
    expect(message.text).toContain("Demandes clôturées supprimées après 5 ans");
    expect(message.text).not.toContain("/mes-droits");
    expect(message.text).not.toContain("CNIL");
  });

  it("refus : motifs de l'équipe et rappel de la CNIL, sauf pour une rétractation", () => {
    const closure = {
      status: "rejected" as const,
      closedAt: "2026-11-20T09:00:00Z",
      erasureExecuted: false,
      response: "Motif <b>précis</b>.",
    };
    const refused = buildPrivacyRequestClosureMessage(
      { ...facts, requestType: "objection" },
      closure,
      envelope,
    );
    expect(refused.text).toContain("Réponse de notre équipe :\nMotif <b>précis</b>.");
    expect(refused.html).toContain("Motif &lt;b&gt;précis&lt;/b&gt;.");
    expect(refused.text).toContain("https://www.cnil.fr/fr/plaintes");
    expect(refused.text).toContain("https://immojudis.test/mes-droits");

    const withdrawal = buildPrivacyRequestClosureMessage(
      { ...facts, requestType: "contract_withdrawal" },
      closure,
      envelope,
    );
    expect(withdrawal.text).not.toContain("CNIL");
  });
});
