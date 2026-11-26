import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  /** Mission lue par `loadOwnedMission`. */
  mission: null as Record<string, unknown> | null,
  /** Lignes rendues par la mise à jour conditionnée. */
  updated: [] as Array<{ id: string }>,
  updateError: null as Error | null,
  calls: [] as Array<{ method: string; args: unknown[] }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/integrations/supabase/client.server", () => {
  class Query {
    private isUpdate = false;
    select(...args: unknown[]) {
      mocks.calls.push({ method: "select", args });
      return this;
    }
    update(...args: unknown[]) {
      this.isUpdate = true;
      mocks.calls.push({ method: "update", args });
      return this;
    }
    eq(...args: unknown[]) {
      mocks.calls.push({ method: "eq", args });
      return this;
    }
    in(...args: unknown[]) {
      mocks.calls.push({ method: "in", args });
      return this;
    }
    single() {
      return Promise.resolve({ data: mocks.mission, error: mocks.mission ? null : new Error("0") });
    }
    then(onFulfilled: (value: { data: unknown; error: unknown }) => unknown) {
      const value = this.isUpdate
        ? { data: mocks.updateError ? null : mocks.updated, error: mocks.updateError }
        : { data: null, error: null };
      return Promise.resolve(value).then(onFulfilled);
    }
  }
  return { supabaseAdmin: { from: () => new Query() } };
});

import { cancelMission } from "@/lib/information-agent/mission-store";

const ADMIN = "admin-1";

beforeEach(() => {
  mocks.mission = { id: "mission-1", user_id: ADMIN, status: "draft" };
  mocks.updated = [{ id: "mission-1" }];
  mocks.updateError = null;
  mocks.calls.length = 0;
});

describe("annulation d'une mission", () => {
  it("mise à jour conditionnée à la mission, à son propriétaire et à un statut annulable", async () => {
    await cancelMission({ adminId: ADMIN, missionId: "mission-1" });
    const update = mocks.calls.findIndex((call) => call.method === "update");
    expect(mocks.calls[update].args[0]).toMatchObject({ status: "cancelled" });
    expect(mocks.calls.slice(update + 1)).toEqual([
      { method: "eq", args: ["id", "mission-1"] },
      { method: "eq", args: ["user_id", ADMIN] },
      { method: "in", args: ["status", ["draft", "failed"]] },
      { method: "select", args: ["id"] },
    ]);
  });

  it("mission déjà envoyée à la lecture : refus 409, aucune écriture", async () => {
    mocks.mission = { id: "mission-1", user_id: ADMIN, status: "sent" };
    await expect(cancelMission({ adminId: ADMIN, missionId: "mission-1" })).rejects.toMatchObject({
      status: 409,
    });
    expect(mocks.calls.some((call) => call.method === "update")).toBe(false);
  });

  it("course : mission prise par un envoi entre la lecture et l'écriture, aucune ligne modifiée, refus 409", async () => {
    mocks.updated = [];
    await expect(cancelMission({ adminId: ADMIN, missionId: "mission-1" })).rejects.toMatchObject({
      status: 409,
      message: "Requête invalide : un message déjà envoyé ne peut pas être annulé.",
    });
  });

  it("erreur de la base à l'écriture : propagée telle quelle", async () => {
    mocks.updateError = new Error("base indisponible");
    await expect(cancelMission({ adminId: ADMIN, missionId: "mission-1" })).rejects.toThrow(
      "base indisponible",
    );
  });

  it("mission d'un autre administrateur : introuvable, aucune écriture", async () => {
    mocks.mission = null;
    await expect(cancelMission({ adminId: ADMIN, missionId: "mission-1" })).rejects.toThrow(
      "Enquête introuvable.",
    );
    expect(mocks.calls.some((call) => call.method === "update")).toBe(false);
  });
});
