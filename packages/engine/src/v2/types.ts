/**
 * V2 Type Definitions
 *
 * Key differences from V1:
 * - No full file bodies in ParsedProgramV2 (only excerpts + line ranges)
 * - Account constraints are fully parsed (not string-matched)
 * - Sinks are first-class objects (not inferred from detector regex)
 * - Candidates carry deterministic reasoning chains
 */

// ─── Source References (no full bodies) ─────────────────────

export interface SourceRef {
  file: string;       // relative path
  startLine: number;
  endLine: number;
}

export interface SourceExcerpt extends SourceRef {
  /** Up to ~30 lines of context around the region of interest. */
  excerpt: string;
}

// ─── Parsed Program V2 ─────────────────────────────────────

export interface ParsedProgramV2 {
  name: string;
  programId?: string;
  framework: "anchor" | "native" | "unknown";
  /** Source file paths + line counts (no content). */
  files: { path: string; lines: number; sha256: string }[];

  instructions: InstructionV2[];
  accountStructs: AccountStructV2[];
  cpiCalls: CPICallV2[];
  pdaDerivations: PDADerivationV2[];
  sinks: SinkV2[];
  macroInvocations: MacroInvocationV2[];
  stateEnums: StateEnumV2[];
  constants: ConstantV2[];

  /** Parsing diagnostics. */
  parseErrors: string[];
  parseDurationMs: number;
}

// ─── Instructions ───────────────────────────────────────────

export interface InstructionV2 {
  name: string;
  ref: SourceRef;
  /** Name of the Context<T> type parameter (Anchor) or null (native). */
  accountsTypeName?: string;
  /** Additional parameters beyond ctx (e.g. amount: u64). */
  params: { name: string; type: string }[];
  /** Which sinks are reachable from this instruction. */
  sinkRefs: number[]; // indices into ParsedProgramV2.sinks
  /** Function calls within body (for cross-ref). */
  calledFunctions: string[];
  /** Excerpt of the instruction body (up to 60 lines). */
  bodyExcerpt: string;
}

// ─── Account Structs ────────────────────────────────────────

export type AnchorAccountType =
  | "Account"
  | "Signer"
  | "Program"
  | "SystemAccount"
  | "UncheckedAccount"
  | "AccountInfo"
  | "AccountLoader"
  | "InterfaceAccount"
  | "Interface"
  | "Box"
  | "Option"
  | "other";

export interface AccountConstraintV2 {
  kind:
    | "init"
    | "init_if_needed"
    | "mut"
    | "signer"
    | "has_one"
    | "constraint"
    | "seeds"
    | "bump"
    | "payer"
    | "space"
    | "close"
    | "token_authority"
    | "token_mint"
    | "associated_token_authority"
    | "associated_token_mint"
    | "address"
    | "owner"
    | "realloc"
    | "rent_exempt"
    | "executable"
    | "zero"
    | "raw";
  /** The raw expression string for constraint/has_one/seeds/address/etc. */
  expression?: string;
  /** For seeds: the seed expressions parsed out. */
  seedExprs?: string[];
  /** For bump: the bump field or literal. */
  bumpExpr?: string;
}

export interface AccountFieldV2 {
  name: string;
  /** Raw type string, e.g. "Account<'info, TokenAccount>". */
  rawType: string;
  /** Resolved outer wrapper type. */
  anchorType: AnchorAccountType;
  /** Inner type if wrapped, e.g. "TokenAccount". */
  innerType?: string;
  /** All parsed constraints from #[account(...)]. */
  constraints: AccountConstraintV2[];
  /** Derived: is this account a signer (type Signer or constraint signer). */
  isSigner: boolean;
  /** Derived: is this account mutable (constraint mut or init). */
  isMut: boolean;
  ref: SourceRef;
}

export interface AccountStructV2 {
  name: string;
  ref: SourceRef;
  fields: AccountFieldV2[];
  /** Whether this is a #[derive(Accounts)] struct. */
  isAccountsDerive: boolean;
  /** Whether any field has init/init_if_needed. */
  hasInit: boolean;
  /** Whether any field has close. */
  hasClose: boolean;
}

// ─── CPI Calls ──────────────────────────────────────────────

export interface CPICallV2 {
  ref: SourceRef;
  /** Which instruction this CPI lives in. */
  instruction: string;
  /** "invoke" | "invoke_signed" | "CpiContext::new" | "CpiContext::new_with_signer" | "token::" | "system_program::" */
  callType: string;
  /** Target program expression, e.g. "ctx.accounts.token_program.to_account_info()" or a pubkey. */
  targetExpr?: string;
  /** Whether target program is validated (typed Program<T> or explicit key check). */
  programValidated: boolean;
  /** Excerpt of the CPI site. */
  excerpt: string;
}

// ─── PDA Derivations ────────────────────────────────────────

export interface PDADerivationV2 {
  ref: SourceRef;
  instruction: string;
  /** Seed expressions (strings, pubkeys, etc.). */
  seeds: string[];
  /** "canonical" | "unchecked" | "missing" */
  bumpHandling: "canonical" | "unchecked" | "missing";
  /** Whether this is in an #[account(seeds=...)] constraint vs inline code. */
  source: "constraint" | "inline";
}

// ─── Sinks (value-critical operations) ──────────────────────

export type SinkType =
  | "sol_transfer"      // system_program::transfer / **lamports
  | "token_transfer"    // token::transfer
  | "token_mint_to"     // token::mint_to
  | "token_burn"        // token::burn
  | "account_close"     // close = <target> / lamport drain
  | "set_authority"     // token::set_authority
  | "realloc"           // realloc constraint or realloc()
  | "invoke_signed"     // PDA-signed CPI (arbitrary)
  | "oracle_read"       // price feed / oracle account read
  | "state_write";      // direct state mutation via mut account

export interface SinkV2 {
  id: number;
  type: SinkType;
  ref: SourceRef;
  instruction: string;
  /** Accounts involved in this sink. */
  involvedAccounts: string[];
  /** Excerpt of the sink operation. */
  excerpt: string;
}

// ─── Macro Invocations ──────────────────────────────────────

export interface MacroInvocationV2 {
  name: string; // "declare_id" | "require" | "require_keys_eq" | "msg" | "emit" etc.
  ref: SourceRef;
  args?: string;
}

// ─── State Enums ────────────────────────────────────────────

export interface StateEnumV2 {
  name: string;
  ref: SourceRef;
  variants: string[];
}

// ─── Constants ──────────────────────────────────────────────

export interface ConstantV2 {
  name: string;
  type: string;
  value: string;
  ref: SourceRef;
}

// ─── Vulnerability Candidates ───────────────────────────────

export type VulnClass =
  | "missing_signer"
  | "missing_owner"
  | "pda_derivation"
  | "arbitrary_cpi"
  | "type_confusion"
  | "reinit"
  | "close_revive"
  | "unchecked_realloc"
  | "integer_overflow"
  | "state_machine"
  | "remaining_accounts"
  | "oracle_validation"
  | "token_authority_mismatch"
  | "stale_post_cpi"
  | "duplicate_account"
  | "unchecked_return"
  | "other";

export type CandidateSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export interface VulnCandidate {
  id: number;
  vulnClass: VulnClass;
  severity: CandidateSeverity;
  confidence: number;   // 0.0-1.0 from deterministic analysis
  instruction: string;
  ref: SourceRef;
  /** Accounts + constraints involved. */
  involvedAccounts: { name: string; constraints: string[] }[];
  /** Deterministic reasoning chain. */
  reason: string;
  /** Which sink triggered this candidate (if any). */
  sinkId?: number;
  /** Fingerprint for dedup. */
  fingerprint: string;
  /** 5-line excerpt around the issue. */
  excerpt: string;
}

// ─── LLM Confirmation Results ───────────────────────────────

export type LLMVerdict = "confirmed" | "rejected" | "uncertain";
export type Exploitability = "easy" | "moderate" | "hard" | "unknown";

export interface LLMConfirmation {
  candidateId: number;
  verdict: LLMVerdict;
  title: string;
  impact: string;
  exploitability: Exploitability;
  proofPlan: string[];
  fix: string[];
  confidence: number;  // 0-100 from LLM
  llmStatus: "success" | "failed" | "skipped";
  reasoning?: string;
}

// ─── V2 Pipeline Result ─────────────────────────────────────

export type FindingStatus = "PROVEN" | "LIKELY" | "NEEDS_HUMAN" | "REJECTED";

export interface V2Finding {
  id: number;
  candidate: VulnCandidate;
  llmConfirmation?: LLMConfirmation;
  pocResult?: PoCValidationResult;
  status: FindingStatus;
  /** Final severity (may differ from candidate after LLM review). */
  finalSeverity: CandidateSeverity;
  /** Final confidence (combined deterministic + LLM). */
  finalConfidence: number;
}

export interface PoCValidationResult {
  status: "proven" | "likely" | "compile_fail" | "timeout" | "disproven";
  testCode?: string;
  testFile?: string;
  compileAttempts?: number;
  compileOutput?: string;
  executionOutput?: string;
  executionTimeMs?: number;
  preState?: Record<string, string>;
  postState?: Record<string, string>;
  /** R2 artifact key for full logs. */
  logsArtifactKey?: string;
}

export interface V2PipelineResult {
  program: ParsedProgramV2;
  candidates: VulnCandidate[];
  findings: V2Finding[];
  /** V1 findings if hybrid mode. */
  v1Findings?: import("../types").FindingResult[];
  /** Hybrid comparison summary. */
  hybridComparison?: HybridComparison;
  metrics: V2Metrics;
}

export interface V2Metrics {
  parseDurationMs: number;
  candidateCount: number;
  llmSelectDurationMs: number;
  llmDeepDiveDurationMs: number;
  llmDeepDiveCount: number;
  llmConfirmedCount: number;
  llmRejectedCount: number;
  pocValidatedCount: number;
  pocProvenCount: number;
  totalDurationMs: number;
}

export interface HybridComparison {
  v1TotalFindings: number;
  v2TotalFindings: number;
  overlap: number;
  v1OnlyCount: number;
  v2OnlyCount: number;
  v1FalsePositivesRejected: number;
  v2NovelFindings: number;
}
