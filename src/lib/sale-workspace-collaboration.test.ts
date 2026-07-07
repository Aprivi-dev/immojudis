import { describe, expect, it } from "vitest";
import {
  collaboratorInviteSchema,
  normalizeEmail,
  workspaceAnnotationCreateSchema,
  workspaceAnnotationUpdateSchema,
} from "@/lib/sale-workspace-collaboration";

const SALE_ID = "7d335032-e935-4550-9347-ed22b0f63449";
const ANNOTATION_ID = "0df74b99-4383-489b-a662-182a7d052b22";

describe("sale workspace collaboration schemas", () => {
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
});
