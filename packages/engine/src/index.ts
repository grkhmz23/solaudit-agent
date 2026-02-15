export * from "./types";
export { runPipeline } from "./pipeline";
export { parseRepo } from "./pipeline/parser";
export { ALL_DETECTORS } from "./detectors";
export {
  buildAuthorityFlowGraph,
  buildTokenFlowGraph,
  buildStateMachineGraph,
  buildPDAGraph,
} from "./graphs";
export { checkConstraints } from "./pipeline/constraints";
export { synthesizeAdversarialAccounts } from "./pipeline/adversarial";
export { planRemediation } from "./remediation/planner";
export { constructProofs } from "./proof/constructor";
export { generateMarkdownReport, generateJsonReport } from "./pipeline/report";

// ── Bounty features ──
export { generatePatches, type CodePatch } from "./remediation/patcher";
export { executePocs, type PoCResult } from "./proof/executor";
export { generatePoCs, type GeneratedPoC } from "./proof/llm-poc-generator";
export { generateSecurityAdvisory, generatePRBody } from "./report/advisory";
export { generateSubmissionDocument, type SubmissionDocOptions } from "./report/submission-doc";
export { scoreRepo, getKnownProtocols, filterAuditableRepos, rankRepos, type RepoCandidate } from "./discovery/repo-selector";
export { runAgent, type AgentConfig, type AgentRun, type AgentReport } from "./agent/orchestrator";

// ── LLM layer ──

export { isLLMAvailable, analyzeFinding, analyzeAllFindings, generatePRContent, generateLLMAdvisory, generateBountyPRBody, type EnrichedFinding, type PRContent, type LLMMetrics, type BountyPRContent } from "./llm/analyzer";
// ── V2 Engine ──

export { runPipelineV2, v2ResultToV1, runHybridPipeline, loadV2Config } from "./v2/index";
export { buildV2Summary, buildV2FullReport, buildV2Advisory } from "./v2/report/index";
export { validatePoCs, generatePoCCode } from "./v2/poc/index";
export type { V2Config, EngineVersion } from "./v2/config";
export type {
  ParsedProgramV2,
  VulnCandidate,
  V2Finding,
  V2PipelineResult,
  V2Metrics,
  HybridComparison,
} from "./v2/types";
export type { V2Summary } from "./v2/report/index";

// ── V3 Engine ──

export { runV3Pipeline, v3ResultToV2 } from "./v3/index";
export type { V3PipelineResult } from "./v3/index";