/**
 * V3 Fact Graph Schema
 *
 * The "truth layer" — a canonical representation of a Solana program
 * that all detectors query against. Every node has a stable ID based
 * on file path + AST position, enabling diff-aware scanning across commits.
 *
 * Design principles:
 *   - Stable IDs: deterministic, reproducible across parses of same code
 *   - Sink-first indexing: graph neighborhoods around sinks are pre-computed
 *   - Query API: detectors never traverse raw AST, only query facts
 */

// ─── Stable IDs ──────────────────────────────────────────────

/**
 * Deterministic ID based on file path + structural position.
 * Format: "programs/amm/src/lib.rs::swap::ctx.vault_a"
 *         "programs/amm/src/lib.rs::Swap::vault_authority"
 *         "programs/amm/src/lib.rs::swap::sink:token_transfer:42"
 */
export type StableId = string;

/**
 * Source location in the codebase.
 */
export interface AstSpan {
  file: string;
  startLine: number;
  endLine: number;
  startCol: number;
  endCol: number;
}

// ─── Sink Kinds ──────────────────────────────────────────────

export type SinkKind =
  | "spl_transfer"
  | "spl_transfer_checked"
  | "spl_mint_to"
  | "spl_burn"
  | "spl_approve"
  | "spl_revoke"
  | "spl_set_authority"
  | "spl_close_account"
  | "system_transfer"
  | "lamport_mutation"
  | "invoke_signed"
  | "invoke"
  | "account_close"
  | "account_realloc"
  | "sysvar_instructions_read"
  | "state_write";

// ─── Guard Kinds ─────────────────────────────────────────────

export type GuardKind =
  | "signer_check"
  | "owner_check"
  | "address_check"
  | "seeds_check"
  | "has_one"
  | "constraint_expr"
  | "require_macro"
  | "assert_macro"
  | "if_check"
  | "token_authority"
  | "token_mint"
  | "token_program"
  | "associated_token";

// ─── Graph Nodes ─────────────────────────────────────────────

export interface ProgramNode {
  id: StableId;
  name: string;
  programId?: string;
  framework: "anchor" | "native" | "unknown";
  /** All source files in this program. */
  files: { path: string; lines: number; sha256: string }[];
  span: AstSpan;
}

export interface InstructionNode {
  id: StableId;
  name: string;
  programId: StableId;
  /** Account fields in this instruction's Accounts struct. */
  accounts: StableId[];
  /** Sinks reachable from this instruction body. */
  sinks: StableId[];
  /** Guards present in this instruction's Accounts struct + body. */
  guards: StableId[];
  /** Instruction visibility: can anyone call it, or is it gated? */
  visibility: "public" | "gated";
  /** Required signers (determined from constraints + code). */
  requiredSigners: StableId[];
  /** Function parameters beyond ctx. */
  params: { name: string; type: string }[];
  /** Functions called from this instruction body. */
  calledFunctions: string[];
  span: AstSpan;
}

export interface AccountNode {
  id: StableId;
  name: string;
  /** Which instruction this account belongs to. */
  instructionId: StableId;
  /** Anchor type wrapper. */
  anchorType: string;
  /** Inner type (e.g., TokenAccount, Mint). */
  innerType?: string;
  /** Raw type string. */
  rawType: string;
  /** Is this account a signer? */
  isSigner: boolean;
  /** Is this account mutable? */
  isMut: boolean;
  /** All constraints on this account. */
  constraints: ConstraintNode[];
  /** Associated PDA derivation, if any. */
  pdaId?: StableId;
  span: AstSpan;
}

export interface ConstraintNode {
  kind: string;
  expression?: string;
  seedExprs?: string[];
  bumpExpr?: string;
}

export interface SinkNode {
  id: StableId;
  kind: SinkKind;
  /** Instruction this sink belongs to. */
  instructionId: StableId;
  /** Accounts used in this sink operation. */
  accountsUsed: StableId[];
  /** Raw code excerpt. */
  excerpt: string;
  span: AstSpan;
}

export interface GuardNode {
  id: StableId;
  kind: GuardKind;
  /** What this guard protects (accounts or sinks). */
  protects: StableId[];
  /** The expression or check being performed. */
  expression?: string;
  span: AstSpan;
}

export interface PdaNode {
  id: StableId;
  /** Seed expressions. */
  seeds: PdaSeed[];
  /** How the bump is sourced. */
  bumpSource: "canonical" | "stored" | "user_provided" | "unknown";
  /** Which program derives this PDA. */
  programId: StableId | "self";
  /** Whether seeds come from constraint or inline code. */
  source: "constraint" | "inline";
  span: AstSpan;
}

export interface PdaSeed {
  expression: string;
  /** Whether this seed includes attacker-controlled input. */
  attackerControlled: boolean;
}

export interface CpiNode {
  id: StableId;
  /** Target program: stable ID if validated, "dynamic" if attacker-chosen. */
  targetProgram: StableId | "dynamic";
  /** Signer seeds used in invoke_signed. */
  signerSeeds: PdaSeed[] | null;
  /** Account metas passed to CPI. */
  accountMetas: StableId[];
  /** Call type. */
  callType: string;
  /** Whether the target program is validated (typed Program<T> or key check). */
  programValidated: boolean;
  span: AstSpan;
}

// ─── Fact Graph ──────────────────────────────────────────────

export interface FactGraph {
  /** Program-level info. */
  programs: Map<StableId, ProgramNode>;
  /** All instructions across all programs. */
  instructions: Map<StableId, InstructionNode>;
  /** All account fields across all instructions. */
  accounts: Map<StableId, AccountNode>;
  /** All sensitive sinks. */
  sinks: Map<StableId, SinkNode>;
  /** All guard checks. */
  guards: Map<StableId, GuardNode>;
  /** All PDA derivations. */
  pdas: Map<StableId, PdaNode>;
  /** All CPI call sites. */
  cpis: Map<StableId, CpiNode>;
  /** Call graph: function → callees. */
  callGraph: Map<StableId, StableId[]>;

  /** Build metadata. */
  metadata: {
    builtAt: string;
    parserVersion: string;
    parseDurationMs: number;
    fileCount: number;
    totalLines: number;
  };
}

// ─── Sink Neighborhood ───────────────────────────────────────

/**
 * Pre-computed "neighborhood" around a sink.
 * Contains everything a detector needs to assess a sink.
 */
export interface SinkNeighborhood {
  sink: SinkNode;
  instruction: InstructionNode;
  /** All accounts involved in or related to this sink. */
  accountsInvolved: AccountNode[];
  /** All guards that protect accounts used by this sink. */
  guardsPresent: GuardNode[];
  /** Taint paths from attacker sources to this sink. */
  taintPaths: { sourceId: StableId; path: StableId[] }[];
  /** Guards that should exist but don't. */
  missingGuards: MissingGuard[];
}

export interface MissingGuard {
  /** What account needs the guard. */
  accountId: StableId;
  /** What kind of guard is expected. */
  expectedKind: GuardKind;
  /** Why we expect this guard (which sink uses this account). */
  reason: string;
  /** Where we searched for the guard. */
  searchedLocations: StableId[];
}

// ─── Fact Graph Diff ─────────────────────────────────────────

/**
 * Diff between two Fact Graphs (for PR diff-aware scanning).
 */
export interface FactGraphDiff {
  /** New nodes added. */
  added: {
    instructions: StableId[];
    sinks: StableId[];
    accounts: StableId[];
    guards: StableId[];
  };
  /** Nodes removed. */
  removed: {
    instructions: StableId[];
    sinks: StableId[];
    accounts: StableId[];
    guards: StableId[];
  };
  /** Nodes modified (same ID, different content). */
  modified: {
    instructions: StableId[];
    sinks: StableId[];
    accounts: StableId[];
    guards: StableId[];
  };
  /** Files that changed. */
  changedFiles: string[];
}

// ─── Instruction Visibility ──────────────────────────────────

export interface InstructionVisibility {
  instructionId: StableId;
  /** Can anyone call this instruction? */
  isPublic: boolean;
  /** If gated, what signers/checks are required? */
  gateConditions: string[];
  /** Required signers to call. */
  requiredSigners: StableId[];
}
