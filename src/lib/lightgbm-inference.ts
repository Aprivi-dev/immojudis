export type LightGbmTreeNode = {
  split_feature?: number;
  threshold?: number | string;
  decision_type?: string;
  default_left?: boolean;
  missing_type?: string;
  left_child?: LightGbmTreeNode;
  right_child?: LightGbmTreeNode;
  leaf_value?: number;
};

export type LightGbmDump = {
  tree_info?: Array<{ tree_structure?: LightGbmTreeNode }>;
  average_output?: boolean;
};

export type LightGbmQuantileArtifact = {
  format: "lightgbm-json-v1";
  target: "log_price_per_m2";
  featureNames: string[];
  models: {
    p10: LightGbmDump;
    p50: LightGbmDump;
    p90: LightGbmDump;
  };
  calibration?: {
    confidenceLevel?: number;
    lowerCorrection?: number;
    upperCorrection?: number;
    method?: string;
  };
};

export type LightGbmQuantilePrediction = {
  p10PricePerM2: number;
  p50PricePerM2: number;
  p90PricePerM2: number;
  coverageTarget: number;
  calibrationMethod: string;
};

export function predictLightGbmQuantiles(
  artifact: unknown,
  featureValues: Record<string, number | null | undefined>,
): LightGbmQuantilePrediction | null {
  if (!isQuantileArtifact(artifact)) return null;
  const vector = artifact.featureNames.map((name) => finiteOrNaN(featureValues[name]));
  const rawP10 = predictDump(artifact.models.p10, vector);
  const rawP50 = predictDump(artifact.models.p50, vector);
  const rawP90 = predictDump(artifact.models.p90, vector);
  if (![rawP10, rawP50, rawP90].every(Number.isFinite)) return null;

  const lowerCorrection = finiteOrZero(artifact.calibration?.lowerCorrection);
  const upperCorrection = finiteOrZero(artifact.calibration?.upperCorrection);
  const p50 = Math.exp(rawP50);
  const p10 = Math.exp(rawP10 - Math.max(0, lowerCorrection));
  const p90 = Math.exp(rawP90 + Math.max(0, upperCorrection));
  if (![p10, p50, p90].every((value) => Number.isFinite(value) && value > 0)) return null;

  return {
    p10PricePerM2: Math.round(Math.min(p10, p50)),
    p50PricePerM2: Math.round(p50),
    p90PricePerM2: Math.round(Math.max(p90, p50)),
    coverageTarget: clamp(artifact.calibration?.confidenceLevel ?? 0.8, 0.5, 0.99),
    calibrationMethod: artifact.calibration?.method ?? "mapie_cqr",
  };
}

function predictDump(dump: LightGbmDump, features: number[]): number {
  const trees = Array.isArray(dump.tree_info) ? dump.tree_info : [];
  if (!trees.length) return Number.NaN;
  const values = trees.map((tree) => evaluateNode(tree.tree_structure, features));
  if (values.some((value) => !Number.isFinite(value))) return Number.NaN;
  const sum = values.reduce((total, value) => total + value, 0);
  return dump.average_output ? sum / values.length : sum;
}

function evaluateNode(node: LightGbmTreeNode | undefined, features: number[]): number {
  if (!node) return Number.NaN;
  if (typeof node.leaf_value === "number") return node.leaf_value;
  if (typeof node.split_feature !== "number") return Number.NaN;

  const value = features[node.split_feature];
  const missing = !Number.isFinite(value);
  let goLeft = Boolean(node.default_left);
  if (!missing) {
    const threshold = Number(node.threshold);
    if (!Number.isFinite(threshold)) return Number.NaN;
    const decisionType = node.decision_type ?? "<=";
    if (decisionType !== "<=" && decisionType !== "<") return Number.NaN;
    goLeft = decisionType === "<" ? value < threshold : value <= threshold;
  }
  return evaluateNode(goLeft ? node.left_child : node.right_child, features);
}

function isQuantileArtifact(value: unknown): value is LightGbmQuantileArtifact {
  if (!value || typeof value !== "object") return false;
  const artifact = value as Partial<LightGbmQuantileArtifact>;
  return (
    artifact.format === "lightgbm-json-v1" &&
    artifact.target === "log_price_per_m2" &&
    Array.isArray(artifact.featureNames) &&
    Boolean(artifact.models?.p10 && artifact.models?.p50 && artifact.models?.p90)
  );
}

function finiteOrNaN(value: number | null | undefined): number {
  return value != null && Number.isFinite(value) ? value : Number.NaN;
}

function finiteOrZero(value: number | null | undefined): number {
  return value != null && Number.isFinite(value) ? value : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
