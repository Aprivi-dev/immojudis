import { authHeaders, readJson } from "@/lib/client-api-core";
import type { ApiKeyCreateInput, ApiKeyCreateResponse, ApiKeyListResponse } from "@/lib/api-keys";

export async function fetchApiKeys(): Promise<ApiKeyListResponse> {
  const response = await fetch("/api/api-keys", {
    headers: await authHeaders(),
  });

  return readJson<ApiKeyListResponse>(response);
}

export async function createApiKey(args: {
  data: ApiKeyCreateInput;
}): Promise<ApiKeyCreateResponse> {
  const response = await fetch("/api/api-keys", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<ApiKeyCreateResponse>(response);
}

export async function revokeApiKey(args: { keyId: string }): Promise<void> {
  const response = await fetch(`/api/api-keys/${encodeURIComponent(args.keyId)}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });

  await readJson<{ key: unknown }>(response);
}
