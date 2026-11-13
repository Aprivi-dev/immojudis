import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminRequiredError, PublicApiError } from "@/lib/api-errors";
import { adminInformationAgentRpcFailure } from "@/lib/admin-information-agent-rpc-failure";

describe("erreur d'une RPC d'administration de l'agent", () => {
  afterEach(() => vi.restoreAllMocks());

  it("un droit refusé est l'erreur d'administrateur requis, jamais le texte de la base", () => {
    const failure = adminInformationAgentRpcFailure("admin.test", {
      code: "42501",
      message: "permission denied for function set_mode",
    });
    expect(failure).toBeInstanceOf(AdminRequiredError);
    expect(failure.message).not.toContain("permission denied");
  });

  it.each([
    ["22023", 400],
    ["55000", 409],
  ])("le refus %s écrit par la fonction est rendu tel quel (%i)", (code, status) => {
    const failure = adminInformationAgentRpcFailure("admin.test", {
      code,
      message: "Mode inconnu.",
    });
    expect(failure).toBeInstanceOf(PublicApiError);
    expect(failure).toMatchObject({ status, message: "Mode inconnu." });
  });

  it("toute autre erreur reçoit un message neutre, le détail reste en cause", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const raw = { code: "23514", message: 'violates check constraint "x" (a@b.test)' };
    const failure = adminInformationAgentRpcFailure("admin.test", raw);
    expect(failure).not.toBeInstanceOf(PublicApiError);
    expect(failure.message).toBe("Database call failed");
    expect(failure.cause).toBe(raw);
  });
});
