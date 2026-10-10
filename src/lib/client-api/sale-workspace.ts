import { authHeaders, readJson } from "@/lib/client-api-core";
import type { AudienceTrackingResponse } from "@/lib/audience-tracking";
import type {
  CollaboratorAcceptInput,
  CollaboratorInviteInput,
  CollaboratorRevokeInput,
  SaleWorkspaceCollaborationResponse,
  WorkspaceAnnotationCreateInput,
  WorkspaceAnnotationUpdateInput,
} from "@/lib/sale-workspace-collaboration";
import type {
  ProfessionalPilotSaveInput,
  SaleWorkspaceInput,
  SaleWorkspaceResponse,
} from "@/lib/sale-workspaces";

export async function fetchSaleWorkspace(args: { saleId: string }): Promise<SaleWorkspaceResponse> {
  const search = new URLSearchParams({ saleId: args.saleId });
  const response = await fetch(`/api/sale-workspace?${search.toString()}`, {
    headers: await authHeaders(),
  });

  return readJson<SaleWorkspaceResponse>(response);
}

export async function fetchAudienceTracking(
  args: {
    includeArchived?: boolean;
  } = {},
): Promise<AudienceTrackingResponse> {
  const search = new URLSearchParams();
  if (args.includeArchived) search.set("includeArchived", "true");
  const response = await fetch(
    `/api/audience-tracking${search.size ? `?${search.toString()}` : ""}`,
    {
      headers: await authHeaders(),
    },
  );

  return readJson<AudienceTrackingResponse>(response);
}

export async function saveSaleWorkspace(args: {
  data: SaleWorkspaceInput;
}): Promise<SaleWorkspaceResponse> {
  const response = await fetch("/api/sale-workspace", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<SaleWorkspaceResponse>(response);
}

export async function saveProfessionalPilotDossier(
  data: ProfessionalPilotSaveInput,
): Promise<SaleWorkspaceResponse> {
  const response = await fetch("/api/sale-workspace/professional-pilot", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(data),
  });
  return readJson<SaleWorkspaceResponse>(response);
}

export async function fetchSaleWorkspaceCollaboration(args: {
  saleId: string;
}): Promise<SaleWorkspaceCollaborationResponse> {
  const search = new URLSearchParams({ saleId: args.saleId });
  const response = await fetch(`/api/sale-workspace/collaboration?${search.toString()}`, {
    headers: await authHeaders(),
  });

  return readJson<SaleWorkspaceCollaborationResponse>(response);
}

export async function inviteSaleWorkspaceCollaboratorClient(args: {
  data: CollaboratorInviteInput;
}) {
  const response = await fetch("/api/sale-workspace/collaboration", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ action: "invite", data: args.data }),
  });

  return readJson(response);
}

export async function acceptSaleWorkspaceInvitationClient(args: { data: CollaboratorAcceptInput }) {
  const response = await fetch("/api/sale-workspace/collaboration", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ action: "accept", data: args.data }),
  });

  return readJson(response);
}

export async function createSaleWorkspaceAnnotationClient(args: {
  data: WorkspaceAnnotationCreateInput;
}) {
  const response = await fetch("/api/sale-workspace/collaboration", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ action: "annotate", data: args.data }),
  });

  return readJson(response);
}

export async function updateSaleWorkspaceAnnotationClient(args: {
  data: WorkspaceAnnotationUpdateInput;
}) {
  const response = await fetch("/api/sale-workspace/collaboration", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ action: "update_annotation", data: args.data }),
  });

  return readJson(response);
}

export async function revokeSaleWorkspaceCollaboratorClient(args: {
  data: CollaboratorRevokeInput;
}) {
  const response = await fetch("/api/sale-workspace/collaboration", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ action: "revoke", data: args.data }),
  });

  return readJson(response);
}
