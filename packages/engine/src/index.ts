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
export { generateSecurityAdvisory, generatePRBody } from "./report/advisory";
export { scoreRepo, getKnownProtocols, filterAuditableRepos, rankRepos, type RepoCandidate } from "./discovery/repo-selector";
export { runAgent, type AgentConfig, type AgentRun, type AgentReport } from "./agent/orchestrator";

// ── LLM layer ──
export { isLLMAvailable, analyzeFinding, analyzeAllFindings, generatePRContent, generateLLMAdvisory, type EnrichedFinding, type PRContent } from "./llm/analyzer";
