import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import {
  acceptSaleWorkspaceInvitation,
  collaboratorInviteSchema,
  normalizeEmail,
  workspaceAnnotationCreateSchema,
  workspaceAnnotationUpdateSchema,
} from "@/lib/sale-workspace-collaboration";

const { serverFrom } = vi.hoisted(() => ({ serverFrom: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: serverFrom },
}));

const SALE_ID = "7d335032-e935-4550-9347-ed22b0f63449";
const ANNOTATION_ID = "0df74b99-4383-489b-a662-182a7d052b22";
const COLLABORATOR_ID = "3d1c6ef4-58b0-4e45-b3bc-e359db7161da";
const COLLABORATOR_USER_ID = "ff15be97-c82c-4b10-9847-e4b05f32d1e3";

describe("sale workspace collaboration schemas", () => {
  beforeEach(() => {
    serverFrom.mockReset();
  });

  it("normalizes collaborator invitations and defaults to commenter role", () => {
    expect(
      collaboratorInviteSchema.parse({
        saleId: SALE_ID,
        invitedEmail: " AVOCAT@example.FR ",
      }),
    ).toEqual({
      saleId: SALE_ID,
      invitedEmail: "avocat@example.fr",
      role: "commenter",
    });
  });

  it("rejects invalid collaborator roles and empty annotations", () => {
    expect(() =>
      collaboratorInviteSchema.parse({
        saleId: SALE_ID,
        invitedEmail: "avocat@example.fr",
        role: "owner",
      }),
    ).toThrow();

    expect(() =>
      workspaceAnnotationCreateSchema.parse({
        saleId: SALE_ID,
        body: "   ",
      }),
    ).toThrow();
  });

  it("validates document annotations and update statuses", () => {
    expect(
      workspaceAnnotationCreateSchema.parse({
        saleId: SALE_ID,
        targetKind: "page",
        pageNumber: 4,
        documentKey: "pv:main",
        body: "Confirmer la clause d'occupation.",
      }),
    ).toMatchObject({
      saleId: SALE_ID,
      targetKind: "page",
      pageNumber: 4,
      documentKey: "pv:main",
      body: "Confirmer la clause d'occupation.",
    });

    expect(
      workspaceAnnotationUpdateSchema.parse({
        annotationId: ANNOTATION_ID,
        status: "resolved",
      }),
    ).toEqual({
      annotationId: ANNOTATION_ID,
      status: "resolved",
    });
  });

  it("normalizes emails consistently", () => {
    expect(normalizeEmail(" User+Test@Example.COM ")).toBe("user+test@example.com");
  });

  it("accepts an invitation only while it is still unclaimed and invited", async () => {
    const collaboration = installInvitationCompareAndSetMock(false);

    const result = await acceptSaleWorkspaceInvitation({
      auth: collaboratorAuth(),
      input: { collaboratorId: COLLABORATOR_ID },
    });

    expect(result.collaborator).toMatchObject({
      id: COLLABORATOR_ID,
      collaborator_user_id: COLLABORATOR_USER_ID,
      status: "accepted",
      revoked_at: null,
    });
    expect(collaboration.current.status).toBe("accepted");
  });

  it("does not overwrite an owner revocation that wins the acceptance race", async () => {
    const collaboration = installInvitationCompareAndSetMock(true);

    await expect(
      acceptSaleWorkspaceInvitation({
        auth: collaboratorAuth(),
        input: { collaboratorId: COLLABORATOR_ID },
      }),
    ).rejects.toThrow("Cette invitation n'est plus disponible.");

    expect(collaboration.current).toMatchObject({
      collaborator_user_id: null,
      status: "revoked",
      revoked_at: "2026-07-27T18:00:00.000Z",
    });
  });
});

function collaboratorAuth(): SupabaseAuthContext {
  return {
    userId: COLLABORATOR_USER_ID,
    claims: { sub: COLLABORATOR_USER_ID, email: "avocat@example.fr" },
    isAdmin: false,
  } as unknown as SupabaseAuthContext;
}

function installInvitationCompareAndSetMock(revokeBeforeCompareAndSet: boolean) {
  const current: Record<string, unknown> = {
    id: COLLABORATOR_ID,
    workspace_id: "37ded89b-796a-4014-a56b-8d46170c3525",
    sale_id: SALE_ID,
    invited_by: "5749ad22-3972-48ff-a305-226772518a49",
    invited_email: "avocat@example.fr",
    collaborator_user_id: null,
    role: "commenter",
    status: "invited",
    accepted_at: null,
    revoked_at: null,
    created_at: "2026-07-27T17:00:00.000Z",
    updated_at: "2026-07-27T17:00:00.000Z",
  };
  let readCompleted = false;

  serverFrom.mockImplementation(() => {
    const filters: Record<string, unknown> = {};
    let updatePayload: Record<string, unknown> | null = null;
    const builder = {
      select() {
        return builder;
      },
      update(payload: Record<string, unknown>) {
        updatePayload = payload;
        return builder;
      },
      eq(column: string, value: unknown) {
        filters[column] = value;
        return builder;
      },
      is(column: string, value: unknown) {
        filters[column] = value;
        return builder;
      },
      async maybeSingle() {
        if (!updatePayload) {
          readCompleted = true;
          return { data: { ...current }, error: null };
        }
        if (readCompleted && revokeBeforeCompareAndSet) {
          current.status = "revoked";
          current.revoked_at = "2026-07-27T18:00:00.000Z";
        }
        const matches = Object.entries(filters).every(
          ([column, value]) => current[column] === value,
        );
        if (!matches) return { data: null, error: null };
        Object.assign(current, updatePayload);
        return { data: { ...current }, error: null };
      },
    };
    return builder;
  });

  return { current };
}
