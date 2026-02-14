/**
 * V2 Parser Entrypoint.
 *
 * Coordinates:
 * 1. Find all .rs files in the repo
 * 2. Parse each with tree-sitter
 * 3. Extract instructions, account structs, sinks, CPIs, PDAs, macros, enums, constants
 * 4. Resolve cross-file references
 * 5. Build ParsedProgramV2
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, relative, basename } from "path";
import { createHash } from "crypto";
import { getRustParser } from "./tree-sitter-init";
import {
  extractInstructions,
  extractAccountStructs,
  extractMacros,
  extractStateEnums,
  extractConstants,
} from "./ast-extract";
import {
  extractSinks,
  extractCPICalls,
  extractPDADerivations,
  pdaFromConstraints,
} from "./sink-extract";
import { resolveReferences } from "./cross-file-resolver";
import type {
  ParsedProgramV2,
  InstructionV2,
  AccountStructV2,
  SinkV2,
  CPICallV2,
  PDADerivationV2,
  MacroInvocationV2,
  StateEnumV2,
  ConstantV2,
} from "../types";

// ─── File Discovery ─────────────────────────────────────────

const SKIP_DIRS = new Set(["target", ".git", "node_modules", ".anchor", "test", "tests", "migrations"]);

function findRustFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        results.push(...findRustFiles(full));
      } else if (entry.isFile() && entry.name.endsWith(".rs")) {
        // Skip very large files (>500KB) — likely generated code
        try {
          const stat = statSync(full);
          if (stat.size < 500_000) results.push(full);
        } catch {
          // skip
        }
      }
    }
  } catch {
    // skip unreadable directories
  }
  return results;
}

/**
 * Detect framework from Cargo.toml.
 */
function detectFramework(repoPath: string): "anchor" | "native" | "unknown" {
  const cargoFiles = findFiles(repoPath, "Cargo.toml");
  for (const cf of cargoFiles) {
    try {
      const content = readFileSync(cf, "utf-8");
      if (content.includes("anchor-lang")) return "anchor";
    } catch { /* skip */ }
  }
  // Check for entrypoint! / process_instruction in .rs files
  const rsFiles = findRustFiles(repoPath).slice(0, 20); // sample first 20
  for (const rf of rsFiles) {
    try {
      const content = readFileSync(rf, "utf-8");
      if (content.includes("entrypoint!") || content.includes("process_instruction")) {
        return "native";
      }
    } catch { /* skip */ }
  }
  return "unknown";
}

function findFiles(dir: string, name: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        results.push(...findFiles(full, name));
      } else if (entry.isFile() && entry.name === name) {
        results.push(full);
      }
    }
  } catch { /* skip */ }
  return results;
}

function extractProgramName(repoPath: string): string {
  const cargoFiles = findFiles(repoPath, "Cargo.toml");
  for (const cf of cargoFiles) {
    try {
      const content = readFileSync(cf, "utf-8");
      const m = content.match(/name\s*=\s*"([^"]+)"/);
      if (m && !m[1].includes("test")) return m[1];
    } catch { /* skip */ }
  }
  return basename(repoPath);
}

function extractProgramId(macros: MacroInvocationV2[]): string | undefined {
  const declareId = macros.find((m) => m.name === "declare_id");
  if (declareId?.args) {
    const m = declareId.args.match(/"([^"]+)"/);
    return m?.[1];
  }
  return undefined;
}

// ─── Main Parser ────────────────────────────────────────────

/**
 * Parse a repository with tree-sitter and extract all V2 structures.
 */
export async function parseRepoV2(repoPath: string): Promise<ParsedProgramV2> {
  const t0 = Date.now();
  const errors: string[] = [];

  // Discover .rs files
  const rsFiles = findRustFiles(repoPath);
  if (rsFiles.length === 0) {
    return emptyProgram(repoPath, Date.now() - t0, ["No .rs files found"]);
  }

  // Init tree-sitter
  let parserKit;
  try {
    parserKit = await getRustParser();
  } catch (e: any) {
    errors.push(`tree-sitter init failed: ${e.message}`);
    return emptyProgram(repoPath, Date.now() - t0, errors);
  }

  const { parser } = parserKit;
  const framework = detectFramework(repoPath);
  const programName = extractProgramName(repoPath);

  // Per-file extraction accumulators
  const allInstructions: InstructionV2[] = [];
  const allAccountStructs: AccountStructV2[] = [];
  const allSinks: SinkV2[] = [];
  const allCPICalls: CPICallV2[] = [];
  const allPDADerivations: PDADerivationV2[] = [];
  const allMacros: MacroInvocationV2[] = [];
  const allEnums: StateEnumV2[] = [];
  const allConstants: ConstantV2[] = [];
  const filesMeta: { path: string; lines: number; sha256: string }[] = [];

  // Renumber sinks globally
  let globalSinkId = 0;

  for (const filePath of rsFiles) {
    let source: string;
    try {
      source = readFileSync(filePath, "utf-8");
    } catch (e: any) {
      errors.push(`Failed to read ${filePath}: ${e.message}`);
      continue;
    }

    const relPath = relative(repoPath, filePath);
    const sha = createHash("sha256").update(source).digest("hex").slice(0, 16);
    const lineCount = source.split("\n").length;
    filesMeta.push({ path: relPath, lines: lineCount, sha256: sha });

    // Parse with tree-sitter
    let tree;
    try {
      tree = parser.parse(source);
    } catch (e: any) {
      errors.push(`tree-sitter parse failed for ${relPath}: ${e.message}`);
      continue;
    }

    if (!tree) {
      errors.push(`tree-sitter returned null for ${relPath}`);
      continue;
    }
    const root = tree.rootNode;

    // Extract each component
    try {
      const instructions = extractInstructions(root, relPath);
      allInstructions.push(...instructions);
    } catch (e: any) {
      errors.push(`Instruction extraction failed for ${relPath}: ${e.message}`);
    }

    try {
      const structs = extractAccountStructs(root, relPath);
      allAccountStructs.push(...structs);

      // Extract PDA derivations from account constraints
      for (const s of structs) {
        const pdas = pdaFromConstraints(s.name, s.fields, relPath, s.ref.startLine);
        allPDADerivations.push(...pdas);
      }
    } catch (e: any) {
      errors.push(`Account struct extraction failed for ${relPath}: ${e.message}`);
    }

    try {
      const sinks = extractSinks(root, relPath);
      // Renumber sinks to be globally unique
      for (const s of sinks) {
        s.id = globalSinkId++;
      }
      allSinks.push(...sinks);
    } catch (e: any) {
      errors.push(`Sink extraction failed for ${relPath}: ${e.message}`);
    }

    try {
      allCPICalls.push(...extractCPICalls(root, relPath));
    } catch (e: any) {
      errors.push(`CPI extraction failed for ${relPath}: ${e.message}`);
    }

    try {
      const pdas = extractPDADerivations(root, relPath, []);
      allPDADerivations.push(...pdas);
    } catch (e: any) {
      errors.push(`PDA extraction failed for ${relPath}: ${e.message}`);
    }

    try {
      allMacros.push(...extractMacros(root, relPath));
    } catch (e: any) {
      errors.push(`Macro extraction failed for ${relPath}: ${e.message}`);
    }

    try {
      allEnums.push(...extractStateEnums(root, relPath));
    } catch (e: any) {
      errors.push(`Enum extraction failed for ${relPath}: ${e.message}`);
    }

    try {
      allConstants.push(...extractConstants(root, relPath));
    } catch (e: any) {
      errors.push(`Constant extraction failed for ${relPath}: ${e.message}`);
    }

    tree.delete();
  }

  // Cross-file resolution
  const resolved = resolveReferences(
    allInstructions,
    allAccountStructs,
    allSinks,
    allCPICalls,
    allPDADerivations,
  );

  const parseDurationMs = Date.now() - t0;

  return {
    name: programName,
    programId: extractProgramId(allMacros),
    framework,
    files: filesMeta,
    instructions: resolved.instructions,
    accountStructs: resolved.accountStructs,
    cpiCalls: resolved.cpiCalls,
    pdaDerivations: resolved.pdaDerivations,
    sinks: resolved.sinks,
    macroInvocations: allMacros,
    stateEnums: allEnums,
    constants: allConstants,
    parseErrors: errors,
    parseDurationMs,
  };
}

function emptyProgram(
  repoPath: string,
  durationMs: number,
  errors: string[],
): ParsedProgramV2 {
  return {
    name: basename(repoPath),
    framework: "unknown",
    files: [],
    instructions: [],
    accountStructs: [],
    cpiCalls: [],
    pdaDerivations: [],
    sinks: [],
    macroInvocations: [],
    stateEnums: [],
    constants: [],
    parseErrors: errors,
    parseDurationMs: durationMs,
  };
}
