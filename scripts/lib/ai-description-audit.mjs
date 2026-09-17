export const DISPLAY_QUALITY_VERSION = "display_quality_20260911_v3";
export function displayAuditIssues(payload, expectedDisplayPromptVersion = null) {
  const text =
    typeof payload.llm_display_description === "string"
      ? payload.llm_display_description.trim()
      : "";
  const issues = [];
  if (!text) return ["missing_llm_display_description"];
  if (text.length < 80) issues.push("short_llm_display_description");
  if (!["accepted", "fallback"].includes(payload.llm_display_status))
    issues.push("unvalidated_display_status");
  if (payload.llm_display_quality_version !== DISPLAY_QUALITY_VERSION)
    issues.push("stale_display_quality");
  if (
    expectedDisplayPromptVersion &&
    payload.llm_display_prompt_version !== expectedDisplayPromptVersion
  ) {
    issues.push(`display_prompt_version:${payload.llm_display_prompt_version || "missing"}`);
  }
  const normalize = (value) => value.replace(/\s+/g, " ").trim();
  for (const quote of payload.llm_display_source_constraints ?? []) {
    if (typeof quote !== "string" || !normalize(text).includes(normalize(quote))) {
      issues.push("missing_source_constraint");
      break;
    }
  }
  return issues;
}
