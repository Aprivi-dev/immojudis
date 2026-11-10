import { describe, expect, it } from "vitest";
import { EMAIL_DELIVERY_LABELS, TRANSIENT_BOUNCE_DETAIL } from "@/lib/email-delivery-status";
import { missionDeliveryState } from "./delivery-state";

const sent = (metadata: unknown = {}) => ({
  provider_message_id: "re_FACTICE_1",
  metadata: metadata as never,
});
const log = (status: string, bounce_type: string | null = null) => ({ status, bounce_type });

describe("missionDeliveryState (onglet Envois)", () => {
  it("ne dit rien d'une mission non envoyée, même avec une ligne de journal", () => {
    expect(
      missionDeliveryState({ provider_message_id: null, metadata: {} }, log("delivered")),
    ).toBeNull();
  });

  it("ne dit rien sans information (journal purgé, aucun rebond noté)", () => {
    expect(missionDeliveryState(sent(), undefined)).toBeNull();
    expect(missionDeliveryState(sent(), log("sent"))).toBeNull();
  });

  it("dit « Échec » quand le fournisseur a renoncé, même après un différé", () => {
    // Le journal ne recule pas : « différé » puis « failed » laisse « failed ».
    expect(missionDeliveryState(sent(), log("failed"))).toBe("failed");
    expect(EMAIL_DELIVERY_LABELS.failed).toEqual({ text: "Échec", tone: "bad" });
    // Rang intermédiaire, comme app_private.email_send_status_rank : un rebond noté l'emporte.
    expect(
      missionDeliveryState(
        sent({ delivery: { status: "bounced", bounce_type: "Permanent" } }),
        log("failed"),
      ),
    ).toBe("bounced");
  });

  it.each([
    [log("delivered"), "delivered"],
    [log("delayed"), "delayed"],
    [log("complained"), "complained"],
    [log("bounced", "transient"), "bounced_temporary"],
    [log("bounced", "TRANSIENT"), "bounced_temporary"],
    [log("bounced", "Permanent"), "bounced"],
    [log("bounced", null), "bounced"],
  ])("lit le journal des envois : %j", (entry, expected) => {
    expect(missionDeliveryState(sent(), entry)).toBe(expected);
  });

  it("garde le rebond ou la plainte noté sur la mission quand le journal est purgé", () => {
    for (const status of ["bounced", "complained"]) {
      expect(missionDeliveryState(sent({ delivery: { status, at: "x" } }), undefined)).toBe(status);
    }
    expect(missionDeliveryState(sent({ delivery: { status: "autre" } }), undefined)).toBeNull();
    expect(missionDeliveryState(sent({ delivery: "bounced" }), undefined)).toBeNull();
  });

  it("journal purgé : un rebond noté « passager » se lit selon le type brut conservé", () => {
    const noted = (bounce_type?: unknown) =>
      missionDeliveryState(
        sent({ delivery: { status: "bounced_temporary", at: "x", bounce_type } }),
        undefined,
      );
    // « transient » : rebond passager, avec la précision.
    expect(noted("Transient")).toBe("bounced_temporary");
    expect(EMAIL_DELIVERY_LABELS.bounced_temporary.detail).toBe(TRANSIENT_BOUNCE_DETAIL);
    // Autre type connu : « Rebond » rouge (règle d'affichage du type inconnu).
    expect(noted("Undetermined")).toBe("bounced");
    expect(noted("Permanent")).toBe("bounced");
    // Type absent (entrée antérieure) : « Rebond passager » SANS « l'adresse reste utilisable ».
    expect(noted(undefined)).toBe("bounced_temporary_unconfirmed");
    expect(noted("")).toBe("bounced_temporary_unconfirmed");
    expect(EMAIL_DELIVERY_LABELS.bounced_temporary_unconfirmed).toEqual({
      text: "Rebond passager",
      tone: "warn",
    });
  });

  it("retient la source la plus grave des deux", () => {
    const temporary = sent({ delivery: { status: "bounced_temporary" } });
    // Le journal précise un rebond de type inconnu : « Rebond », pas « passager ».
    expect(missionDeliveryState(temporary, log("bounced", null))).toBe("bounced");
    // Le journal en retard (évènement de rebond non écrit) ne masque pas le rebond noté.
    expect(missionDeliveryState(temporary, log("delivered"))).toBe("bounced_temporary_unconfirmed");
    // À gravité égale, le journal (qui connaît le type) l'emporte.
    expect(missionDeliveryState(temporary, log("bounced", "transient"))).toBe("bounced_temporary");
    expect(missionDeliveryState(sent({ delivery: { status: "complained" } }), log("bounced"))).toBe(
      "complained",
    );
  });
});
