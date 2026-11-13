import { beforeEach, describe, expect, it, vi } from "vitest";

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: fromMock } }));

import { PublicApiError } from "@/lib/api-errors";
import { revokeUserApiKey } from "@/lib/api-keys";

const KEY_ID = "11111111-1111-4111-8111-111111111111";
const auth = { userId: "user-1" } as never;

function keyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: KEY_ID,
    user_id: "user-1",
    name: "Ma clé",
    key_prefix: "ij_live_abcdefghij",
    scopes: ["sales.feed:read"],
    last_used_at: null,
    revoked_at: null,
    expires_at: "2027-01-01T00:00:00.000Z",
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Une requête chaînable qui rend `result` à la fin (`maybeSingle`) et garde les appels. */
function query(result: { data: unknown; error?: unknown }) {
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "update", "eq", "is"]) {
    builder[method] = vi.fn().mockReturnValue(builder);
  }
  builder.maybeSingle = vi.fn().mockResolvedValue({ error: null, ...result });
  return builder;
}

describe("revokeUserApiKey", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("refuses a malformed identifier with a 400 before any database call", async () => {
    const error = await revokeUserApiKey({ auth, keyId: "not-a-uuid" }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(PublicApiError);
    expect((error as PublicApiError).status).toBe(400);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("accepts any UUID Postgres accepts, as the rest of the application (`uuid.ts`)", async () => {
    // Version 0 and upper case: refused by zod's strict UUID, accepted by Postgres.
    const keyId = "ABCDEF12-0000-0000-0000-000000000000";
    const update = query({ data: keyRow({ id: keyId, revoked_at: "2026-10-31T10:00:00.000Z" }) });
    fromMock.mockReturnValueOnce(update);

    await revokeUserApiKey({ auth, keyId });

    expect(update.eq).toHaveBeenCalledWith("id", keyId);
  });

  it("revokes an active key of the account and sets the revocation date", async () => {
    const update = query({ data: keyRow({ revoked_at: "2026-10-31T10:00:00.000Z" }) });
    fromMock.mockReturnValueOnce(update);

    const result = await revokeUserApiKey({ auth, keyId: KEY_ID });

    expect(result.key.revokedAt).toBe("2026-10-31T10:00:00.000Z");
    expect(update.eq).toHaveBeenCalledWith("id", KEY_ID);
    expect(update.eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(update.is).toHaveBeenCalledWith("revoked_at", null);
  });

  it("answers 404 for an unknown key, or one that belongs to someone else", async () => {
    fromMock.mockReturnValueOnce(query({ data: null })).mockReturnValueOnce(query({ data: null }));

    const error = await revokeUserApiKey({ auth, keyId: KEY_ID }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(PublicApiError);
    expect((error as PublicApiError).status).toBe(404);
  });

  it("keeps the original revocation date of a key that is already revoked", async () => {
    const original = "2026-09-01T08:00:00.000Z";
    const update = query({ data: null });
    const read = query({ data: keyRow({ revoked_at: original }) });
    fromMock.mockReturnValueOnce(update).mockReturnValueOnce(read);

    const result = await revokeUserApiKey({ auth, keyId: KEY_ID });

    expect(result.key.revokedAt).toBe(original);
    // La seconde requête ne fait que lire : aucune écriture ne remplace la date.
    expect(read.update).not.toHaveBeenCalled();
    expect(read.eq).toHaveBeenCalledWith("user_id", "user-1");
  });

  it("lets a database failure through as a server error", async () => {
    fromMock.mockReturnValueOnce(query({ data: null, error: new Error("connection reset") }));

    await expect(revokeUserApiKey({ auth, keyId: KEY_ID })).rejects.toThrow("connection reset");
  });
});
