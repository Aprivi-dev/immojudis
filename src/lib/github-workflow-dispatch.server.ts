import "server-only";

/**
 * Requête `workflow_dispatch` vers GitHub Actions, sans charge utile ni journalisation : l'appelant choisit le
 * jeton, le dépôt, le workflow et la référence, puis interprète le statut. Utilisée par le déclenchement du
 * workflow d'inondation et par celui de l'analyse des réponses de l'agent.
 */
export async function postGitHubWorkflowDispatch({
  token,
  repository,
  workflow,
  ref,
  fetcher = fetch,
}: {
  token: string;
  repository: string;
  workflow: string;
  ref: string;
  fetcher?: typeof fetch;
}): Promise<Response> {
  return fetcher(
    `https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref }),
      signal: AbortSignal.timeout(12_000),
    },
  );
}
