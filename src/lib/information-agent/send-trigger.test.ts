import { describe, expect, it, vi } from "vitest";

const from = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from, rpc: vi.fn() } }));

import { approveAndSendMission, markTrigger } from "@/lib/information-agent/send";
import { issueAutopilotTrigger } from "@/lib/information-agent/schemas";
import { createAdminInformationAgentDraft } from "@/lib/information-agent/draft";

const pilotDraftMetadata = {
  email_content_template_revision: 9,
  trigger: "autopilot",
  autopilot_run_id: "run-1",
  autopilot_simulated: true,
};

describe("marque trigger d'un envoi", () => {
  it("un brouillon du pilote validé À LA MAIN perd sa marque : trigger = manual, sans run ni simulation", () => {
    const metadata = markTrigger({ ...pilotDraftMetadata }, undefined);
    expect(metadata).toMatchObject({ trigger: "manual", email_content_template_revision: 9 });
    expect(metadata).not.toHaveProperty("autopilot_run_id");
    expect(metadata).not.toHaveProperty("autopilot_simulated");
  });

  it("un envoi du pilote porte trigger = autopilot et son passage", () => {
    const metadata = markTrigger(
      { email_content_template_revision: 9 },
      issueAutopilotTrigger("run-2"),
    );
    expect(metadata).toMatchObject({ trigger: "autopilot", autopilot_run_id: "run-2" });
  });

  it("un envoi manuel d'une mission ordinaire est marqué manual", () => {
    expect(markTrigger({}, undefined)).toEqual({ trigger: "manual" });
  });
});

describe("déclencheur opaque", () => {
  const forged = { kind: "autopilot" as const, runId: "forge" };

  it("l'envoi refuse un déclencheur qui n'a pas été émis par le pilote, avant toute lecture", async () => {
    await expect(
      approveAndSendMission({
        adminId: "a",
        input: {} as never,
        fetchImpl: fetch,
        trigger: forged,
      }),
    ).rejects.toThrow("Déclencheur d'envoi automatique non reconnu.");
    expect(from).not.toHaveBeenCalled();
  });

  it("le brouillon refuse aussi un déclencheur forgé", async () => {
    await expect(
      createAdminInformationAgentDraft({
        auth: { isAdmin: true, userId: "a" } as never,
        input: { saleId: "11111111-1111-4111-8111-111111111111" },
        trigger: forged,
      }),
    ).rejects.toThrow("non reconnu");
    expect(from).not.toHaveBeenCalled();
  });

  it("un déclencheur émis est figé", () => {
    const trigger = issueAutopilotTrigger("run-3", { phase: 1 });
    expect(Object.isFrozen(trigger)).toBe(true);
  });
});
