/**
 * Sink & CPI Extraction from tree-sitter AST.
 *
 * Sinks = value-critical operations:
 *   - SOL/token transfers, mint, burn
 *   - Account close / lamport drain
 *   - set_authority
 *   - realloc
 *   - invoke_signed (PDA-signed CPI)
 *   - Oracle reads
 *   - State mutations
 *
 * Also extracts CPI call sites and PDA derivations.
 */

import type { Node as TSNode } from "web-tree-sitter";
import type {
  SinkV2,
  SinkType,
  CPICallV2,
  PDADerivationV2,
  SourceRef,
} from "../types";

// ─── Helpers ────────────────────────────────────────────────

function ref(node: TSNode, file: string): SourceRef {
  return {
    file,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

function excerpt(node: TSNode, contextLines = 5): string {
  const lines = node.text.split("\n");
  return lines.slice(0, contextLines * 2 + 1).join("\n");
}

function walk(node: TSNode, fn: (n: TSNode) => void): void {
  fn(node);
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c) walk(c, fn);
  }
}

/**
 * Find the enclosing function name for a given node.
 */
function enclosingFunction(node: TSNode): string {
  let cur: TSNode | null = node;
  while (cur) {
    if (cur.type === "function_item") {
      const name = cur.childForFieldName("name");
      return name?.text || "unknown";
    }
    cur = cur.parent;
  }
  return "unknown";
}

/**
 * Find the enclosing function_item node.
 */
function enclosingFunctionNode(node: TSNode): TSNode | null {
  let cur: TSNode | null = node;
  while (cur) {
    if (cur.type === "function_item") return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Extract account names referenced in a code region.
 */
function extractAccountRefs(text: string): string[] {
  const refs = new Set<string>();
  const ctxMatches = text.matchAll(/ctx\.accounts\.(\w+)/g);
  for (const m of ctxMatches) refs.add(m[1]);
  const nextAccMatches = text.matchAll(/next_account_info\s*\(\s*(\w+)/g);
  for (const m of nextAccMatches) refs.add(m[1]);
  // Also catch direct variable references like `authority`, `vault`, etc.
  const directRefs = text.matchAll(/(?:^|\s)(\w+)\.(?:key|to_account_info|lamports|is_signer)/gm);
  for (const m of directRefs) refs.add(m[1]);
  return [...refs];
}

// ─── Sink Extraction ────────────────────────────────────────

interface SinkPattern {
  type: SinkType;
  /** Regex to match in call expression or field expression text. */
  patterns: RegExp[];
}

const SINK_PATTERNS: SinkPattern[] = [
  {
    type: "token_transfer",
    patterns: [
      /token::transfer/,
      /transfer_checked/,
      /spl_token.*Transfer/,
      /anchor_spl::token::transfer/,
    ],
  },
  {
    type: "token_mint_to",
    patterns: [/token::mint_to/, /mint_to/, /MintTo/],
  },
  {
    type: "token_burn",
    patterns: [/token::burn/, /Burn/],
  },
  {
    type: "sol_transfer",
    patterns: [
      /system_program::transfer/,
      /system_instruction::transfer/,
      /\*\*.*\.lamports\.borrow_mut\(\)/,
      /\.try_borrow_mut_lamports/,
    ],
  },
  {
    type: "account_close",
    patterns: [
      /close_account/,
      /\.close\s*\(/,
      // Lamport drain pattern: dest.lamports += src.lamports; src.lamports = 0
      /lamports.*=\s*0/,
    ],
  },
  {
    type: "set_authority",
    patterns: [
      /set_authority/,
      /SetAuthority/,
      /token::set_authority/,
    ],
  },
  {
    type: "oracle_read",
    patterns: [
      /price_feed/,
      /get_price/,
      /switchboard/,
      /pyth/i,
      /oracle/i,
      /AggregatorAccountData/,
    ],
  },
  {
    type: "invoke_signed",
    patterns: [
      /invoke_signed\s*\(/,
      /CpiContext::new_with_signer/,
    ],
  },
  {
    type: "realloc",
    patterns: [
      /\.realloc\s*\(/,
      /realloc\s*=/,
    ],
  },
];

export function extractSinks(root: TSNode, file: string): SinkV2[] {
  const sinks: SinkV2[] = [];
  let id = 0;

  // Scan call expressions and method calls
  walk(root, (node) => {
    if (node.type !== "call_expression" && node.type !== "assignment_expression" &&
        node.type !== "method_call") return;

    const text = node.text;
    for (const pattern of SINK_PATTERNS) {
      for (const regex of pattern.patterns) {
        if (regex.test(text)) {
          sinks.push({
            id: id++,
            type: pattern.type,
            ref: ref(node, file),
            instruction: enclosingFunction(node),
            involvedAccounts: extractAccountRefs(text),
            excerpt: excerpt(node),
          });
          return; // Only match first pattern per node
        }
      }
    }

    // State write detection: direct or aliased account field mutations
    if (node.type === "assignment_expression") {
      const lhs = node.childForFieldName("left");
      if (lhs) {
        const lhsText = lhs.text;
        // Direct: ctx.accounts.X.field = value
        // Aliased: state.field = value (where state was let state = &mut ctx.accounts.X)
        const isDirect = /ctx\.accounts\.\w+\.\w+/.test(lhsText);
        const isFieldSet = /^\w+\.\w+$/.test(lhsText) && !lhsText.includes("::");

        if (isDirect || isFieldSet) {
          // For aliased writes, check if the enclosing function has &mut ctx.accounts
          const fnNode = enclosingFunctionNode(node);
          const fnText = fnNode?.text ?? "";
          const isAccountAlias = isFieldSet && fnText.length > 0 &&
            /&mut\s+ctx\.accounts\./.test(fnText);

          if (isDirect || isAccountAlias) {
            sinks.push({
              id: id++,
              type: "state_write",
              ref: ref(node, file),
              instruction: enclosingFunction(node),
              involvedAccounts: extractAccountRefs(isDirect ? text : fnText || text),
              excerpt: excerpt(node),
            });
          }
        }
      }
    }
  });

  return sinks;
}

// ─── CPI Call Extraction ────────────────────────────────────

export function extractCPICalls(root: TSNode, file: string): CPICallV2[] {
  const calls: CPICallV2[] = [];

  walk(root, (node) => {
    if (node.type !== "call_expression") return;
    const text = node.text;

    let callType: string | null = null;
    if (/invoke_signed\s*\(/.test(text)) callType = "invoke_signed";
    else if (/invoke\s*\(/.test(text)) callType = "invoke";
    else if (/CpiContext::new_with_signer/.test(text)) callType = "CpiContext::new_with_signer";
    else if (/CpiContext::new\b/.test(text)) callType = "CpiContext::new";
    else if (/token::\w+/.test(text)) callType = "token::*";
    else if (/system_program::\w+/.test(text)) callType = "system_program::*";
    else if (/anchor_spl::token::\w+/.test(text)) callType = "anchor_spl::token::*";

    if (!callType) return;

    // Check if target program is validated
    // A typed Program<'info, Token> validates automatically
    // An AccountInfo passed as program needs explicit key check
    const instruction = enclosingFunction(node);
    const targetExpr = extractCPITarget(node);
    const programValidated = /Program</.test(text) || /token_program/.test(text) ||
      callType.startsWith("token::") || callType.startsWith("system_program::");

    calls.push({
      ref: ref(node, file),
      instruction,
      callType,
      targetExpr,
      programValidated,
      excerpt: excerpt(node),
    });
  });

  return calls;
}

function extractCPITarget(callNode: TSNode): string | undefined {
  const text = callNode.text;

  // invoke(program_id, ...) or invoke_signed(program_id, ...)
  const invokeMatch = text.match(/invoke(?:_signed)?\s*\(\s*&?([^,]+)/);
  if (invokeMatch) return invokeMatch[1].trim().slice(0, 80);

  // CpiContext::new(program.to_account_info(), ...)
  const cpiMatch = text.match(/CpiContext::new(?:_with_signer)?\s*\(\s*([^,]+)/);
  if (cpiMatch) return cpiMatch[1].trim().slice(0, 80);

  return undefined;
}

// ─── PDA Derivation Extraction ──────────────────────────────

export function extractPDADerivations(
  root: TSNode,
  file: string,
  constraintPDAs: PDADerivationV2[],
): PDADerivationV2[] {
  const derivations: PDADerivationV2[] = [...constraintPDAs];

  walk(root, (node) => {
    if (node.type !== "call_expression") return;
    const text = node.text;

    // Pubkey::find_program_address(&[seeds], program_id)
    if (/find_program_address/.test(text)) {
      const instruction = enclosingFunction(node);
      const seedsMatch = text.match(/&\[([^\]]+)\]/);
      const seeds = seedsMatch
        ? seedsMatch[1].split(",").map((s) => s.trim()).filter(Boolean)
        : [];

      derivations.push({
        ref: ref(node, file),
        instruction,
        seeds,
        bumpHandling: "canonical",
        source: "inline",
      });
    }

    // Pubkey::create_program_address (unchecked bump)
    if (/create_program_address/.test(text)) {
      const instruction = enclosingFunction(node);
      const seedsMatch = text.match(/&\[([^\]]+)\]/);
      const seeds = seedsMatch
        ? seedsMatch[1].split(",").map((s) => s.trim()).filter(Boolean)
        : [];

      derivations.push({
        ref: ref(node, file),
        instruction,
        seeds,
        bumpHandling: "unchecked",
        source: "inline",
      });
    }
  });

  return derivations;
}

/**
 * Extract PDA derivations from parsed account struct constraints.
 * Called during cross-file resolution when account struct constraints
 * contain seeds = [...] + bump = ... patterns.
 */
export function pdaFromConstraints(
  structName: string,
  fields: { name: string; constraints: { kind: string; seedExprs?: string[]; bumpExpr?: string }[] }[],
  file: string,
  startLine: number,
): PDADerivationV2[] {
  const derivations: PDADerivationV2[] = [];

  for (const field of fields) {
    const seedsConstraint = field.constraints.find((c) => c.kind === "seeds");
    if (!seedsConstraint?.seedExprs) continue;

    const bumpConstraint = field.constraints.find((c) => c.kind === "bump");

    derivations.push({
      ref: { file, startLine, endLine: startLine },
      instruction: structName, // Will be resolved to actual instruction later
      seeds: seedsConstraint.seedExprs,
      bumpHandling: bumpConstraint?.bumpExpr ? "canonical" : "missing",
      source: "constraint",
    });
  }

  return derivations;
}
