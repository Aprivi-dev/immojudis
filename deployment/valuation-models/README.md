# Valuation model deployment artifacts

This directory is the local hand-off location used by
`scripts/publish-valuation-models.mjs` when a trained valuation model must be
validated and published during a production deployment.

Generated JSON bundles are intentionally excluded from Git:

- training is reproducible from `services/data-pipeline/src/valuation_training.py`;
- GitHub Actions stores each trained bundle as an auditable workflow artifact;
- active production models are persisted in Supabase's
  `valuation_model_versions` registry.

To validate local bundles without publishing them:

```bash
node scripts/publish-valuation-models.mjs --force --validate-only
```
