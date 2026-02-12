// ── Core Types for the Solana Audit Engine ──

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export type ProofStatus =
  | "PENDING"
  | "PLANNED"
  | "RUNNING"
  | "PROVEN"
  | "DISPROVEN"
  | "SKIPPED"
  | "ERROR";

export interface SourceLocation {
  file: string;
  line: number;
  endLine?: number;
  instruction?: string;
}

export interface FindingResult {
  classId: number;
  className: string;
  severity: Severity;
  title: string;
  location: SourceLocation;
  confidence: number;
  hypothesis: string;
  proofPlan?: ProofPlan;
  fixPlan?: FixPlan;
  blastRadius?: BlastRadius;
}

export interface ProofPlan {
  steps: string[];
  harness?: string;
  requiredCommands?: string[];
  deltaSchema?: DeltaSchema;
}

export interface DeltaSchema {
  preState: Record<string, unknown>;
  postState: Record<string, unknown>;
  assertion: string;
}

export interface FixPlan {
  pattern: string;
  description: string;
  code?: string;
  regressionTests?: string[];
}

export interface BlastRadius {
  affectedAccounts: string[];
  affectedInstructions: string[];
  signerChanges: string[];
}

// ── Parsed Solana Program Structures ──

export interface ParsedProgram {
  name: string;
  programId?: string;
  framework: "anchor" | "native" | "unknown";
  files: ParsedFile[];
  instructions: ParsedInstruction[];
  accounts: ParsedAccountStruct[];
  cpiCalls: CPICall[];
  pdaDerivations: PDADerivation[];
  errorCodes: ErrorCode[];
}

export interface ParsedFile {
  path: string;
  content: string;
  lines: string[];
}

export interface ParsedInstruction {
  name: string;
  file: string;
  line: number;
  endLine: number;
  body: string;
  accounts: InstructionAccount[];
  signerChecks: string[];
  ownerChecks: string[];
  cpiCalls: string[];
  arithmeticOps: ArithmeticOp[];
}

export interface InstructionAccount {
  name: string;
  isSigner: boolean;
  isMut: boolean;
  constraints: string[];
  type?: string;
}

export interface CPICall {
  file: string;
  line: number;
  instruction: string;
  targetProgram: string;
  programValidated: boolean;
  accountsAfterCPI: string[];
}

export interface PDADerivation {
  file: string;
  line: number;
  seeds: string[];
  bumpHandling: "canonical" | "unchecked" | "missing";
  instruction: string;
}

export interface ErrorCode {
  name: string;
  code: number;
}

export interface ArithmeticOp {
  file: string;
  line: number;
  op: string;
  checked: boolean;
}

export interface ParsedAccountStruct {
  name: string;
  file: string;
  line: number;
  fields: AccountField[];
  discriminator?: string;
  hasInitCheck: boolean;
  hasCloseHandler: boolean;
}

export interface AccountField {
  name: string;
  type: string;
  line: number;
}

// ── Graph Types ──

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  label: string;
  metadata?: Record<string, unknown>;
}

export interface AuditGraph {
  name: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ── Pipeline Types ──

export interface PipelineContext {
  repoPath: string;
  mode: "SCAN" | "PROVE" | "FIX_PLAN";
  onProgress: (stage: string, percent: number) => Promise<void>;
}

export interface PipelineResult {
  program: ParsedProgram;
  findings: FindingResult[];
  graphs: AuditGraph[];
  summary: AuditSummary;
  reportMarkdown: string;
  reportJson: object;
}

export interface AuditSummary {
  shipReady: boolean;
  totalFindings: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  infoCount: number;
  recommendation: string;
  programName: string;
  framework: string;
  instructionCount: number;
  accountStructCount: number;
}

// ── Detector Interface ──

export interface Detector {
  id: number;
  name: string;
  detect(program: ParsedProgram): FindingResult[];
}

// ── Constraint Checker Interface (formal-ish reasoning) ──

export interface Constraint {
  type: string;
  subject: string;
  predicate: string;
  expected: string;
  actual?: string;
}

export interface ConstraintViolation {
  constraint: Constraint;
  message: string;
  severity: Severity;
}
