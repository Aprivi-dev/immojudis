/**
 * Versions the web app expects from the data pipeline. A single place: `llm-versions.test.ts`
 * compares them with `DEFAULT_LLM_PROMPT_VERSION` (services/data-pipeline/src/config.py) and
 * `DISPLAY_QUALITY_VERSION` (services/data-pipeline/src/enrichment/display_quality.py), so a bump
 * on the Python side fails the tests until this file follows.
 */
export const EXPECTED_LLM_PROMPT_VERSION = "auction_llm_v10_structured_display";
export const EXPECTED_DISPLAY_QUALITY_VERSION = "display_quality_20261103_v5";
