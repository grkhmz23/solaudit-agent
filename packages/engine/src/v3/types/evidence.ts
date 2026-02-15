/**
 * V3 Evidence Chain Types
 *
 * Every finding with severity >= Medium must carry a structured evidence chain.
 * Evidence references point into the Fact Graph using stable IDs, not text.
 *
 * The chain answers five questions:
 *   1. What is the claim? (vulnerability class + description)
 *   2. Where is the sensitive sink? (what operation is at risk)
 *   3. What does the attacker control? (which inputs/accounts)
 *   4. What guard is missing? (proven via negative fact graph query)
 *   5. What is the bypass path? (source → sink with no guard)
 */

import type { TrustGrade } from "./trust-grade";
import type { StableId, AstSpan, SinkKind, GuardKind } from "./fact-graph";
import type { VulnClass, CandidateSeverity } from "../../v2/types";

// ─── Evidence Chain ──────────────────────────────────────────

export interface EvidenceChain {
  findingId: string;
  trustGrade: TrustGrade;

  /** 1. What is the claim? */
  claim: {
    vulnerabilityClass: VulnClass;
    description: string;
    /** One-sentence summary for report headers. */
    title: string;
  };

  /** 2. Where is the sensitive sink? */
  sensitiveSink: {
    sinkId: StableId;
    kind: SinkKind;
    span: AstSpan;
    /** Human-readable impact statement. */
    impact: string;
  };

  /** 3. What does the attacker control? */
  attackerControl: {
    /** Accounts/data the attacker can supply. */
    sourceIds: StableId[];
    description: string;
    /** Taint propagation path, if computed. */
    taintPath: TaintPath | null;
  };

  /** 4. What guard is missing? (proven by negative query) */
  missingGuardProof: {
    /** The type of guard we expected to find. */
    expectedGuard: GuardKind;
    /** Fact Graph nodes where we searched. */
    searchedLocations: StableId[];
    /** Guards that exist but are insufficient. */
    foundGuards: StableId[];
    /** The proof statement: "No X guard exists for account Y used by sink Z". */
    absenceProof: string;
  };

  /** 5. What is the bypass path? */
  bypassPath: {
    /** Step-by-step from attacker input to exploit. */
    steps: BypassStep[];
    /** Witness transaction (if Grade A). */
    witnessTransaction: WitnessTransaction | null;
  };

  /** Severity after trust grade enforcement. */
  enforcedSeverity: CandidateSeverity;
  /** Raw confidence from deterministic analysis. */
  confidence: number;
}

// ─── Taint Path ──────────────────────────────────────────────

export interface TaintPath {
  /** Ordered list of nodes from source to sink. */
  nodes: TaintNode[];
}

export interface TaintNode {
  id: StableId;
  kind: "source" | "propagation" | "guard" | "sink";
  description: string;
  span: AstSpan;
}

// ─── Bypass Steps ────────────────────────────────────────────

export interface BypassStep {
  order: number;
  action: string;
  /** Which fact graph node this step involves. */
  nodeId?: StableId;
  /** Code reference. */
  span?: AstSpan;
}

// ─── Witness Transaction (Grade A proof) ─────────────────────

export interface WitnessTransaction {
  /** How the proof was generated. */
  proofMode: "anchor_test" | "bankrun" | "program_test" | "trace";
  /** Complete test file content. */
  testCode?: string;
  /** Test file path. */
  testFile?: string;
  /** State before exploit. */
  preState: AccountSnapshot[];
  /** State after exploit. */
  postState: AccountSnapshot[];
  /** Delta showing what changed. */
  stateDelta: StateDelta[];
  /** Transaction logs. */
  logs?: string;
  /** Whether this PoC was actually executed and verified. */
  verified: boolean;
}

export interface AccountSnapshot {
  address: string;
  owner: string;
  lamports: string;
  dataHash?: string;
  /** Decoded fields if available. */
  decoded?: Record<string, string>;
}

export interface StateDelta {
  account: string;
  field: string;
  before: string;
  after: string;
  impact: string;
}

// ─── Verification Modes ──────────────────────────────────────

export type VerificationMode = "static" | "trace" | "runnable";

export interface VerificationResult {
  findingId: string;
  mode: VerificationMode;
  /** Honest declaration of runnability. */
  runnable: boolean;
  /** If not runnable, what's missing. */
  missingInputs: string[];

  /** For static proof (Grade B). */
  staticProof?: {
    evidenceChain: EvidenceChain;
    guardAbsenceQuery: string;
    taintPath: TaintPath;
  };

  /** For trace proof (Grade A). */
  traceProof?: {
    simulationLogs: string;
    stateBefore: AccountSnapshot[];
    stateAfter: AccountSnapshot[];
    stateDelta: StateDelta[];
  };

  /** For runnable PoC (Grade A). */
  runnableProof?: {
    testFile: string;
    testFramework: "anchor" | "bankrun" | "program_test";
    setupInstructions: string;
    expectedOutput: string;
  };
}
