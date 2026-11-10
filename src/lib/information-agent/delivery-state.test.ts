import { describe, expect, it } from "vitest";
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
    expect(missionDeliveryState(sent(), log("failed"))).toBeNull();
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
    for (const status of ["bounced", "bounced_temporary", "complained"]) {
      expect(missionDeliveryState(sent({ delivery: { status, at: "x" } }), undefined)).toBe(status);
    }
    expect(missionDeliveryState(sent({ delivery: { status: "autre" } }), undefined)).toBeNull();
    expect(missionDeliveryState(sent({ delivery: "bounced" }), undefined)).toBeNull();
  });

  it("retient la source la plus grave des deux", () => {
    const temporary = sent({ delivery: { status: "bounced_temporary" } });
    // Le journal précise un rebond de type inconnu : « Rebond », pas « passager ».
    expect(missionDeliveryState(temporary, log("bounced", null))).toBe("bounced");
    // Le journal en retard (évènement de rebond non écrit) ne masque pas le rebond noté.
    expect(missionDeliveryState(temporary, log("delivered"))).toBe("bounced_temporary");
    expect(missionDeliveryState(sent({ delivery: { status: "complained" } }), log("bounced"))).toBe(
      "complained",
    );
  });
});
