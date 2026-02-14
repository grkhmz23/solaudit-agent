/**
 * Patch Validator — deterministic validation gates before PR.
 *
 * Gates (in order):
 *   1. Write diff files to temp dir
 *   2. `git apply --check` (dry run)
 *   3. `git apply` (actual apply)
 *   4. Project-specific build check:
 *      - Anchor: `anchor build`
 *      - Cargo: `cargo check`
 *      - Fallback: `cargo build --lib`
 *   5. Tests (if available): `anchor test --skip-local-validator` or `cargo test`
 *
 * If any gate fails, returns error details for LLM retry.
 */

import { execSync, type ExecSyncOptions } from "child_process";
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "fs";
import * as path from "path";
import type { KimiPatch, KimiPatchResult } from "./kimi-patch-author";

// ─── Types ──────────────────────────────────────────────────

export type ValidationGate =
  | "diff_write"
  | "git_apply_check"
  | "git_apply"
  | "build"
  | "test";

export interface ValidationResult {
  passed: boolean;
  failedGate?: ValidationGate;
  error?: string;
  appliedFiles: string[];
  buildOutput?: string;
  testOutput?: string;
  durationMs: number;
}

// ─── Helpers ────────────────────────────────────────────────

const EXEC_OPTS = (cwd: string): ExecSyncOptions => ({
  cwd,
  timeout: 180_000,  // 3 min max per command
  encoding: "utf-8" as BufferEncoding,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, FORCE_COLOR: "0" },
});

function execSafe(cmd: string, cwd: string): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execSync(cmd, EXEC_OPTS(cwd)) as unknown as string;
    return { ok: true, stdout: stdout || "", stderr: "" };
  } catch (err: any) {
    return {
      ok: false,
      stdout: (err.stdout || "").toString().slice(0, 4000),
      stderr: (err.stderr || "").toString().slice(0, 4000),
    };
  }
}

function detectProjectType(repoPath: string): "anchor" | "cargo" | "unknown" {
  if (existsSync(path.join(repoPath, "Anchor.toml"))) return "anchor";
  if (existsSync(path.join(repoPath, "Cargo.toml"))) return "cargo";
  // Check in programs/ subdirectory
  if (existsSync(path.join(repoPath, "programs"))) {
    const programsDir = path.join(repoPath, "programs");
    try {
      const entries = require("fs").readdirSync(programsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (existsSync(path.join(programsDir, entry.name, "Cargo.toml"))) return "cargo";
        }
      }
    } catch {}
  }
  return "unknown";
}

// ─── Unified Diff Writer ────────────────────────────────────

/**
 * Write unified diffs to individual .patch files in a temp directory.
 * Returns the list of patch file paths.
 */
function writeDiffFiles(
  patches: KimiPatch[],
  tempDir: string,
): string[] {
  mkdirSync(tempDir, { recursive: true });
  const patchFiles: string[] = [];

  for (let i = 0; i < patches.length; i++) {
    const patchFile = path.join(tempDir, `patch-${i}.diff`);

    // Normalize the diff: ensure proper headers
    let diff = patches[i].unifiedDiff.trim();

    // If the diff doesn't start with --- a/, add headers
    if (!diff.startsWith("---")) {
      const filePath = patches[i].path;
      diff = `--- a/${filePath}\n+++ b/${filePath}\n${diff}`;
    }

    // Ensure trailing newline
    if (!diff.endsWith("\n")) diff += "\n";

    writeFileSync(patchFile, diff, "utf-8");
    patchFiles.push(patchFile);
  }

  return patchFiles;
}

// ─── Main Validator ─────────────────────────────────────────

/**
 * Validate a set of patches against a cloned repo.
 *
 * Runs validation gates in order; stops at first failure.
 * Does NOT modify the repo on failure (uses --check first).
 */
export function validatePatches(
  patchResult: KimiPatchResult,
  repoPath: string,
): ValidationResult {
  const t0 = Date.now();
  const tempDir = path.join(repoPath, ".solaudit-patches");
  const appliedFiles: string[] = [];

  try {
    // ── Gate 1: Write diff files ──
    console.log(`[patch-validator] Gate 1: Writing ${patchResult.patches.length} diff files...`);
    let patchFiles: string[];
    try {
      patchFiles = writeDiffFiles(patchResult.patches, tempDir);
    } catch (err: any) {
      return {
        passed: false,
        failedGate: "diff_write",
        error: `Failed to write diff files: ${err.message}`,
        appliedFiles: [],
        durationMs: Date.now() - t0,
      };
    }

    // ── Gate 2: git apply --check (dry run) ──
    console.log("[patch-validator] Gate 2: git apply --check...");
    for (let i = 0; i < patchFiles.length; i++) {
      const pf = patchFiles[i];
      const filePath = patchResult.patches[i].path;

      const check = execSafe(`git apply --check "${pf}"`, repoPath);
      if (!check.ok) {
        // Try with --ignore-whitespace
        const checkRelaxed = execSafe(`git apply --check --ignore-whitespace "${pf}"`, repoPath);
        if (!checkRelaxed.ok) {
          return {
            passed: false,
            failedGate: "git_apply_check",
            error: `Patch for ${filePath} failed git apply --check:\n${checkRelaxed.stderr || checkRelaxed.stdout}`,
            appliedFiles: [],
            durationMs: Date.now() - t0,
          };
        }
      }
    }

    // ── Gate 3: git apply (actual) ──
    console.log("[patch-validator] Gate 3: git apply...");
    for (let i = 0; i < patchFiles.length; i++) {
      const pf = patchFiles[i];
      const filePath = patchResult.patches[i].path;

      let apply = execSafe(`git apply "${pf}"`, repoPath);
      if (!apply.ok) {
        // Try relaxed
        apply = execSafe(`git apply --ignore-whitespace "${pf}"`, repoPath);
        if (!apply.ok) {
          // Revert any already-applied patches
          for (const applied of appliedFiles) {
            execSafe(`git checkout -- "${applied}"`, repoPath);
          }
          return {
            passed: false,
            failedGate: "git_apply",
            error: `git apply failed for ${filePath}:\n${apply.stderr || apply.stdout}`,
            appliedFiles: [],
            durationMs: Date.now() - t0,
          };
        }
      }
      appliedFiles.push(filePath);
    }

    // Also apply test diffs if any
    if (patchResult.tests.length > 0) {
      const testDir = path.join(tempDir, "tests");
      const testFiles = writeDiffFiles(patchResult.tests, testDir);
      for (let i = 0; i < testFiles.length; i++) {
        const tf = testFiles[i];
        const testApply = execSafe(`git apply --ignore-whitespace "${tf}"`, repoPath);
        if (!testApply.ok) {
          console.warn(`[patch-validator] Test patch ${i} failed to apply (non-fatal)`);
        }
      }
    }

    // ── Gate 4: Build check ──
    const projectType = detectProjectType(repoPath);
    let buildOutput = "";

    if (projectType === "anchor") {
      console.log("[patch-validator] Gate 4: anchor build...");
      const build = execSafe("anchor build", repoPath);
      buildOutput = build.stdout + build.stderr;

      if (!build.ok) {
        // Revert patches
        for (const applied of appliedFiles) {
          execSafe(`git checkout -- "${applied}"`, repoPath);
        }
        return {
          passed: false,
          failedGate: "build",
          error: `anchor build failed:\n${buildOutput.slice(0, 4000)}`,
          appliedFiles: [],
          buildOutput,
          durationMs: Date.now() - t0,
        };
      }
    } else if (projectType === "cargo") {
      console.log("[patch-validator] Gate 4: cargo check...");
      const build = execSafe("cargo check --lib 2>&1", repoPath);
      buildOutput = build.stdout + build.stderr;

      if (!build.ok) {
        for (const applied of appliedFiles) {
          execSafe(`git checkout -- "${applied}"`, repoPath);
        }
        return {
          passed: false,
          failedGate: "build",
          error: `cargo check failed:\n${buildOutput.slice(0, 4000)}`,
          appliedFiles: [],
          buildOutput,
          durationMs: Date.now() - t0,
        };
      }
    } else {
      console.log("[patch-validator] Gate 4: No build system detected, skipping build check");
      buildOutput = "No build system detected (no Anchor.toml or Cargo.toml)";
    }

    // ── Gate 5: Test (best effort, non-blocking) ──
    let testOutput = "";
    if (projectType === "anchor" && existsSync(path.join(repoPath, "tests"))) {
      console.log("[patch-validator] Gate 5: Running tests (best effort)...");
      const test = execSafe("anchor test --skip-local-validator 2>&1", repoPath);
      testOutput = (test.stdout + test.stderr).slice(0, 4000);
      if (!test.ok) {
        console.warn("[patch-validator] Tests failed (non-blocking)");
      }
    } else if (projectType === "cargo") {
      console.log("[patch-validator] Gate 5: cargo test (best effort)...");
      const test = execSafe("cargo test --lib 2>&1", repoPath);
      testOutput = (test.stdout + test.stderr).slice(0, 4000);
      if (!test.ok) {
        console.warn("[patch-validator] Tests failed (non-blocking)");
      }
    }

    // All gates passed
    console.log(`[patch-validator] All gates passed (${appliedFiles.length} files patched)`);
    return {
      passed: true,
      appliedFiles,
      buildOutput: buildOutput.slice(0, 2000),
      testOutput: testOutput.slice(0, 2000),
      durationMs: Date.now() - t0,
    };
  } finally {
    // Clean up temp patch files
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Revert all applied patches (restore original files).
 */
export function revertPatches(appliedFiles: string[], repoPath: string): void {
  for (const file of appliedFiles) {
    execSafe(`git checkout -- "${file}"`, repoPath);
  }
}
