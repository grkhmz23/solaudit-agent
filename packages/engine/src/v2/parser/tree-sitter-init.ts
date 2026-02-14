/**
 * Tree-sitter WASM initialization.
 *
 * Loads the web-tree-sitter runtime + tree-sitter-rust grammar.
 * Singleton: only initializes once, subsequent calls return cached parser.
 */

import { Parser, Language } from "web-tree-sitter";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

let cachedParser: Parser | null = null;
let cachedLanguage: Language | null = null;

/**
 * Get (or create) a tree-sitter Parser with Rust language loaded.
 *
 * The WASM file is resolved relative to this source file's directory.
 * At runtime (after tsup bundle), it should be copied alongside the dist.
 * Fallback: check common locations.
 */
export async function getRustParser(): Promise<{ parser: Parser; language: Language }> {
  if (cachedParser && cachedLanguage) {
    return { parser: cachedParser, language: cachedLanguage };
  }

  await Parser.init();

  const parser = new Parser();

  // Resolve WASM path — try multiple locations
  const wasmCandidates = [
    // Source tree (development)
    resolve(dirname(fileURLToPath(import.meta.url)), "wasm", "tree-sitter-rust.wasm"),
    // Monorepo root node_modules (pnpm hoist)
    resolve(process.cwd(), "node_modules", "tree-sitter-rust", "tree-sitter-rust.wasm"),
    // Engine package node_modules
    resolve(process.cwd(), "packages", "engine", "node_modules", "tree-sitter-rust", "tree-sitter-rust.wasm"),
    // Fallback: pnpm store
    resolve(process.cwd(), "node_modules", ".pnpm", "tree-sitter-rust@0.24.0", "node_modules", "tree-sitter-rust", "tree-sitter-rust.wasm"),
  ];

  let wasmBuf: Uint8Array | null = null;
  for (const candidate of wasmCandidates) {
    try {
      wasmBuf = readFileSync(candidate);
      if (wasmBuf.length > 1000) break; // valid WASM is >1KB
      wasmBuf = null;
    } catch {
      // try next
    }
  }

  if (!wasmBuf) {
    throw new Error(
      `[v2-parser] tree-sitter-rust.wasm not found. Checked:\n${wasmCandidates.join("\n")}`,
    );
  }

  const language = await Language.load(wasmBuf);
  parser.setLanguage(language);

  cachedParser = parser;
  cachedLanguage = language;
  return { parser, language };
}
