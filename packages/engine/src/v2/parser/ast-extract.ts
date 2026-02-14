/**
 * AST Extraction from tree-sitter parse tree.
 *
 * Extracts:
 * - Instructions (Anchor #[program] module fns, native process_* fns)
 * - Account structs with #[derive(Accounts)] + per-field constraints
 * - Macro invocations (declare_id!, require!, require_keys_eq!, msg!, emit!)
 * - State enums (#[account] enums or enums used in state)
 * - Constants
 */

import type { Node as TSNode } from "web-tree-sitter";
import type {
  InstructionV2,
  AccountStructV2,
  AccountFieldV2,
  AccountConstraintV2,
  AnchorAccountType,
  MacroInvocationV2,
  StateEnumV2,
  ConstantV2,
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

function excerpt(node: TSNode, maxLines = 60): string {
  const lines = node.text.split("\n");
  if (lines.length <= maxLines) return node.text;
  return lines.slice(0, maxLines).join("\n") + "\n// ... truncated";
}

/**
 * Find all children of a given type (non-recursive).
 */
function childrenOfType(node: TSNode, type: string): TSNode[] {
  const out: TSNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === type) out.push(c);
  }
  return out;
}

/**
 * Walk all descendants of a node, calling fn for each.
 */
function walk(node: TSNode, fn: (n: TSNode) => void): void {
  fn(node);
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c) walk(c, fn);
  }
}

/**
 * Collect all descendants matching a type.
 */
function findAll(node: TSNode, type: string): TSNode[] {
  const out: TSNode[] = [];
  walk(node, (n) => { if (n.type === type) out.push(n); });
  return out;
}

/**
 * Get the attribute items immediately preceding a node (looking backwards in siblings).
 */
function precedingAttributes(node: TSNode): TSNode[] {
  const attrs: TSNode[] = [];
  const parent = node.parent;
  if (!parent) return attrs;

  // Walk backwards through siblings
  let found = false;
  for (let i = parent.childCount - 1; i >= 0; i--) {
    const sibling = parent.child(i);
    if (!sibling) continue;
    if (sibling.id === node.id) { found = true; continue; }
    if (found && sibling.type === "attribute_item") {
      attrs.unshift(sibling);
    } else if (found && sibling.type !== "attribute_item") {
      break;
    }
  }
  return attrs;
}

/**
 * Extract the attribute name from an attribute_item node.
 * e.g. #[program] → "program", #[derive(Accounts)] → "derive"
 */
function attrName(attrItem: TSNode): string {
  const attr = attrItem.childForFieldName("attribute") || findAll(attrItem, "attribute")[0];
  if (!attr) return "";
  const ident = attr.childForFieldName("identifier") || findAll(attr, "identifier")[0];
  return ident?.text || "";
}

/**
 * Extract the full attribute text from token_tree.
 * e.g. #[derive(Accounts)] → "Accounts"
 * e.g. #[account(init, payer = authority)] → "init, payer = authority"
 */
function attrArgs(attrItem: TSNode): string {
  const attr = findAll(attrItem, "attribute")[0];
  if (!attr) return "";
  const tt = findAll(attr, "token_tree")[0];
  if (!tt) return "";
  // Strip outer parens
  const text = tt.text;
  if (text.startsWith("(") && text.endsWith(")")) return text.slice(1, -1).trim();
  return text;
}

// ─── Instruction Extraction ─────────────────────────────────

/**
 * Extract instructions from a parsed file's AST root.
 */
export function extractInstructions(root: TSNode, file: string): InstructionV2[] {
  const instructions: InstructionV2[] = [];

  // Strategy 1: Anchor — find #[program] attribute, then extract pub fn from the mod
  const modItems = findAll(root, "mod_item");
  for (const mod of modItems) {
    const attrs = precedingAttributes(mod);
    const isProgramMod = attrs.some((a) => attrName(a) === "program");
    if (!isProgramMod) continue;

    // Extract all pub fn items inside this module
    const fns = findAll(mod, "function_item");
    for (const fn of fns) {
      const vis = findAll(fn, "visibility_modifier")[0];
      if (!vis || vis.text !== "pub") continue;

      const nameNode = fn.childForFieldName("name");
      const name = nameNode?.text || "unknown";
      const params = extractFnParams(fn);
      const ctxType = extractContextType(fn);
      const calledFns = extractCalledFunctions(fn);

      instructions.push({
        name,
        ref: ref(fn, file),
        accountsTypeName: ctxType || undefined,
        params,
        sinkRefs: [], // populated later by sink extraction
        calledFunctions: calledFns,
        bodyExcerpt: excerpt(fn),
      });
    }
  }

  // Strategy 2: Native — find fn process_* or fn handle_*
  if (instructions.length === 0) {
    const fns = findAll(root, "function_item");
    for (const fn of fns) {
      const nameNode = fn.childForFieldName("name");
      const name = nameNode?.text || "";
      if (!name.startsWith("process_") && !name.startsWith("handle_")) continue;

      const params = extractFnParams(fn);
      const calledFns = extractCalledFunctions(fn);

      instructions.push({
        name,
        ref: ref(fn, file),
        params,
        sinkRefs: [],
        calledFunctions: calledFns,
        bodyExcerpt: excerpt(fn),
      });
    }
  }

  return instructions;
}

function extractFnParams(fn: TSNode): { name: string; type: string }[] {
  const params: { name: string; type: string }[] = [];
  const paramList = fn.childForFieldName("parameters");
  if (!paramList) return params;

  for (const p of findAll(paramList, "parameter")) {
    const pattern = p.childForFieldName("pattern");
    const typeNode = p.childForFieldName("type");
    const name = pattern?.text || "";
    const type = typeNode?.text || "";
    // Skip ctx: Context<...> — that's the accounts context
    if (name === "ctx" || name === "_ctx") continue;
    if (name && type) params.push({ name, type });
  }
  return params;
}

function extractContextType(fn: TSNode): string | null {
  const paramList = fn.childForFieldName("parameters");
  if (!paramList) return null;

  for (const p of findAll(paramList, "parameter")) {
    const pattern = p.childForFieldName("pattern");
    if (pattern?.text === "ctx" || pattern?.text === "_ctx") {
      const typeNode = p.childForFieldName("type");
      if (!typeNode) return null;
      // Context<Initialize> → "Initialize"
      const text = typeNode.text;
      const m = text.match(/Context<'?,?\s*(\w+)>/);
      return m ? m[1] : null;
    }
  }
  return null;
}

function extractCalledFunctions(fn: TSNode): string[] {
  const calls: string[] = [];
  const seen = new Set<string>();
  walk(fn, (n) => {
    if (n.type === "call_expression") {
      const funcNode = n.childForFieldName("function");
      if (funcNode) {
        const text = funcNode.text;
        if (!seen.has(text) && text.length < 80) {
          seen.add(text);
          calls.push(text);
        }
      }
    }
  });
  return calls;
}

// ─── Account Struct Extraction ──────────────────────────────

/**
 * Extract #[derive(Accounts)] structs with per-field constraint parsing.
 */
export function extractAccountStructs(root: TSNode, file: string): AccountStructV2[] {
  const structs: AccountStructV2[] = [];
  const structItems = findAll(root, "struct_item");

  for (const si of structItems) {
    const attrs = precedingAttributes(si);

    // Check for #[derive(Accounts)]
    const isAccountsDerive = attrs.some((a) => {
      return attrName(a) === "derive" && attrArgs(a).includes("Accounts");
    });

    // Also check for #[account] structs (state structs)
    const isAccountAttr = attrs.some((a) => attrName(a) === "account");

    if (!isAccountsDerive && !isAccountAttr) continue;

    const nameNode = si.childForFieldName("name");
    const name = nameNode?.text || "unknown";

    const fields = extractAccountFields(si, file);

    structs.push({
      name,
      ref: ref(si, file),
      fields,
      isAccountsDerive,
      hasInit: fields.some((f) =>
        f.constraints.some((c) => c.kind === "init" || c.kind === "init_if_needed"),
      ),
      hasClose: fields.some((f) => f.constraints.some((c) => c.kind === "close")),
    });
  }

  return structs;
}

function extractAccountFields(structNode: TSNode, file: string): AccountFieldV2[] {
  const fields: AccountFieldV2[] = [];
  const fieldDecls = findAll(structNode, "field_declaration");

  for (const fd of fieldDecls) {
    const nameNode = fd.childForFieldName("name");
    const typeNode = fd.childForFieldName("type");
    const name = nameNode?.text || "";
    const rawType = typeNode?.text || "";

    // Parse preceding #[account(...)] attributes
    const attrs = precedingAttributes(fd);
    const constraints: AccountConstraintV2[] = [];

    for (const attr of attrs) {
      if (attrName(attr) === "account") {
        const args = attrArgs(attr);
        constraints.push(...parseAccountConstraints(args));
      }
    }

    // Determine anchor type from rawType
    const { anchorType, innerType } = resolveAnchorType(rawType);

    // Derive signer/mut from constraints + type
    const isSigner =
      anchorType === "Signer" ||
      constraints.some((c) => c.kind === "signer");
    const isMut =
      constraints.some((c) => c.kind === "mut" || c.kind === "init" || c.kind === "init_if_needed");

    fields.push({
      name,
      rawType,
      anchorType,
      innerType,
      constraints,
      isSigner,
      isMut,
      ref: ref(fd, file),
    });
  }

  return fields;
}

// ─── Anchor Constraint Parsing ──────────────────────────────

/**
 * Parse the arguments string of #[account(...)].
 *
 * Handles:
 * - Simple flags: init, mut, signer, zero, rent_exempt, executable
 * - Key-value: payer = authority, space = 8 + 32, close = receiver
 * - Expressions: constraint = authority.key() == state.admin
 * - Seeds: seeds = [b"vault", state.key().as_ref()]
 * - has_one = authority
 * - address = some_program::ID
 */
export function parseAccountConstraints(args: string): AccountConstraintV2[] {
  const constraints: AccountConstraintV2[] = [];
  if (!args.trim()) return constraints;

  // Split on commas, but respect nested parens/brackets
  const parts = splitConstraintArgs(args);

  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;

    // Simple flags
    if (part === "mut") { constraints.push({ kind: "mut" }); continue; }
    if (part === "signer") { constraints.push({ kind: "signer" }); continue; }
    if (part === "init") { constraints.push({ kind: "init" }); continue; }
    if (part === "init_if_needed") { constraints.push({ kind: "init_if_needed" }); continue; }
    if (part === "zero") { constraints.push({ kind: "zero" }); continue; }
    if (part === "executable") { constraints.push({ kind: "executable" }); continue; }
    if (part === "bump") { constraints.push({ kind: "bump" }); continue; }
    if (part === "rent_exempt = skip" || part === "rent_exempt = enforce") {
      constraints.push({ kind: "rent_exempt", expression: part }); continue;
    }

    // Key-value patterns (support namespaced keys like token::authority)
    const kvMatch = part.match(/^([\w:]+)\s*=\s*(.+)$/s);
    if (kvMatch) {
      const [, key, val] = kvMatch;
      const value = val.trim();

      switch (key) {
        case "payer":
          constraints.push({ kind: "payer", expression: value });
          break;
        case "space":
          constraints.push({ kind: "space", expression: value });
          break;
        case "close":
          constraints.push({ kind: "close", expression: value });
          break;
        case "has_one":
          constraints.push({ kind: "has_one", expression: value });
          break;
        case "address":
          constraints.push({ kind: "address", expression: value });
          break;
        case "owner":
          constraints.push({ kind: "owner", expression: value });
          break;
        case "bump":
          constraints.push({ kind: "bump", bumpExpr: value });
          break;
        case "constraint":
          constraints.push({ kind: "constraint", expression: value });
          break;
        case "seeds":
          constraints.push({
            kind: "seeds",
            expression: value,
            seedExprs: parseSeedArray(value),
          });
          break;
        case "realloc":
          constraints.push({ kind: "realloc", expression: value });
          break;
        case "token::authority":
          constraints.push({ kind: "token_authority", expression: value });
          break;
        case "token::mint":
          constraints.push({ kind: "token_mint", expression: value });
          break;
        case "associated_token::authority":
          constraints.push({ kind: "associated_token_authority", expression: value });
          break;
        case "associated_token::mint":
          constraints.push({ kind: "associated_token_mint", expression: value });
          break;
        default:
          // Unknown constraint — store as raw
          constraints.push({ kind: "raw", expression: part });
      }
      continue;
    }

    // has_one shorthand: has_one = field (sometimes written as standalone)
    if (part.startsWith("has_one")) {
      const m = part.match(/has_one\s*=\s*(.+)/);
      if (m) constraints.push({ kind: "has_one", expression: m[1].trim() });
      continue;
    }

    // Catch-all: store as raw
    constraints.push({ kind: "raw", expression: part });
  }

  return constraints;
}

/**
 * Split constraint args on top-level commas, respecting nested brackets/parens.
 */
function splitConstraintArgs(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";

  for (const ch of args) {
    if (ch === "(" || ch === "[" || ch === "<") depth++;
    if (ch === ")" || ch === "]" || ch === ">") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/**
 * Parse a seeds array expression like `[b"vault", user.key().as_ref()]`.
 */
function parseSeedArray(expr: string): string[] {
  const inner = expr.replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!inner) return [];
  return splitConstraintArgs(inner).map((s) => s.trim());
}

/**
 * Resolve Anchor account type from raw type string.
 */
function resolveAnchorType(rawType: string): { anchorType: AnchorAccountType; innerType?: string } {
  // Strip Box<...> wrapper
  let type = rawType;
  const boxMatch = type.match(/^Box<(.+)>$/);
  if (boxMatch) type = boxMatch[1];

  // Strip Option<...> wrapper
  const optionMatch = type.match(/^Option<(.+)>$/);
  if (optionMatch) type = optionMatch[1];

  // Match known Anchor types
  const patterns: [RegExp, AnchorAccountType][] = [
    [/^Signer</, "Signer"],
    [/^Program</, "Program"],
    [/^SystemAccount</, "SystemAccount"],
    [/^UncheckedAccount</, "UncheckedAccount"],
    [/^AccountInfo</, "AccountInfo"],
    [/^AccountLoader</, "AccountLoader"],
    [/^InterfaceAccount</, "InterfaceAccount"],
    [/^Interface</, "Interface"],
    [/^Account</, "Account"],
  ];

  for (const [pattern, anchorType] of patterns) {
    if (pattern.test(type)) {
      // Extract inner type: Account<'info, TokenAccount> → TokenAccount
      const innerMatch = type.match(/<'?\w*,?\s*(\w+)>/);
      return { anchorType, innerType: innerMatch?.[1] };
    }
  }

  return { anchorType: "other" };
}

// ─── Macro Invocations ──────────────────────────────────────

export function extractMacros(root: TSNode, file: string): MacroInvocationV2[] {
  const macros: MacroInvocationV2[] = [];
  const interesting = new Set([
    "declare_id", "require", "require_keys_eq", "require_keys_neq",
    "require_gt", "require_gte", "require_eq", "require_neq",
    "msg", "emit", "emit_cpi", "solana_program::msg",
  ]);

  walk(root, (n) => {
    if (n.type !== "macro_invocation") return;
    const nameNode = findAll(n, "identifier")[0] ||
      findAll(n, "scoped_identifier")[0];
    const name = nameNode?.text || "";
    if (!interesting.has(name)) return;

    const tt = findAll(n, "token_tree")[0];
    macros.push({
      name,
      ref: ref(n, file),
      args: tt?.text?.slice(1, -1).trim(), // strip parens
    });
  });

  return macros;
}

// ─── State Enums ────────────────────────────────────────────

export function extractStateEnums(root: TSNode, file: string): StateEnumV2[] {
  const enums: StateEnumV2[] = [];
  const enumItems = findAll(root, "enum_item");

  for (const ei of enumItems) {
    const nameNode = ei.childForFieldName("name");
    const name = nameNode?.text || "";

    // Look for #[account] attribute or state-like names
    const attrs = precedingAttributes(ei);
    const isState = attrs.some((a) => attrName(a) === "account") ||
      /[Ss]tate|[Ss]tatus|[Pp]hase/.test(name);

    if (!isState) continue;

    const variants: string[] = [];
    const body = ei.childForFieldName("body");
    if (body) {
      for (const v of findAll(body, "enum_variant")) {
        const vName = v.childForFieldName("name");
        if (vName) variants.push(vName.text);
      }
    }

    enums.push({ name, ref: ref(ei, file), variants });
  }

  return enums;
}

// ─── Constants ──────────────────────────────────────────────

export function extractConstants(root: TSNode, file: string): ConstantV2[] {
  const constants: ConstantV2[] = [];

  walk(root, (n) => {
    if (n.type !== "const_item") return;
    const nameNode = n.childForFieldName("name");
    const typeNode = n.childForFieldName("type");
    const valueNode = n.childForFieldName("value");
    if (nameNode && typeNode && valueNode) {
      constants.push({
        name: nameNode.text,
        type: typeNode.text,
        value: valueNode.text.slice(0, 200),
        ref: ref(n, file),
      });
    }
  });

  return constants;
}
