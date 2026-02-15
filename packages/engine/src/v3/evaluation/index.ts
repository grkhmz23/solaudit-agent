/**
 * V3 Evaluation Harness — barrel exports.
 */

export { GOLDEN_SUITE, getTotalExpectedFindings, getReposByDifficulty } from "./golden-suite";
export type { GoldenRepo, ExpectedFinding, MatchCriteria, FalsePositiveTrap } from "./golden-suite";

export { scoreRepo, aggregateResults, matchFinding } from "./scorer";
export type { ActualFinding, RepoEvalResult, SuiteEvalResult, ClassMetric, MatchResult } from "./scorer";

export { evalFullSuite, evalSingleRepo, compareRuns } from "./runner";
export type { EvalConfig, ComparisonResult } from "./runner";

export { SYNTHETIC_FIXTURES, generateFixturesOnDisk } from "./fixtures/index";
export type { SyntheticFixture } from "./fixtures/index";
