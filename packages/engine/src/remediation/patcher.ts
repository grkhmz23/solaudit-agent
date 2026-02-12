import * as fs from "fs";
import * as path from "path";
import type { FindingResult, ParsedProgram } from "../types";

export interface CodePatch {
  file: string;
  originalContent: string;
  patchedContent: string;
  diff: string;
  description: string;
}

/**
 * Generate real code patches for findings with fix plans.
 * Returns modified file contents and unified diffs.
 */
export function generatePatches(
  findings: FindingResult[],
  program: ParsedProgram,
  repoPath: string
): CodePatch[] {
  const patches: CodePatch[] = [];
  const cache = new Map<string, string>();

  const getFile = (rel: string): string | null => {
    if (cache.has(rel)) return cache.get(rel)!;
    try {
      const c = fs.readFileSync(path.join(repoPath, rel), "utf-8");
      cache.set(rel, c);
      return c;
    } catch {
      return null;
    }
  };

  for (const f of findings) {
    if (!f.fixPlan?.code && !f.fixPlan?.pattern) continue;
    if (["constraint-analysis", "adversarial-synthesis"].includes(f.location.file)) continue;

    const content = getFile(f.location.file);
    if (!content) continue;

    const patched = applyFix(content, f);
    if (!patched || patched === content) continue;

    // Update cache so subsequent patches stack
    cache.set(f.location.file, patched);

    patches.push({
      file: f.location.file,
      originalContent: content,
      patchedContent: patched,
      diff: makeDiff(f.location.file, content, patched),
      description: f.fixPlan?.description || f.title,
    });
  }

  return patches;
}

function applyFix(content: string, f: FindingResult): string | null {
  const lines = content.split("\n");
  const idx = f.location.line - 1;
  if (idx < 0 || idx >= lines.length) return null;

  switch (f.classId) {
    case 1: return fixMissingSigner(lines);
    case 2: return fixMissingOwner(lines, idx);
    case 3: return fixPDADerivation(lines, idx);
    case 4: return fixArbitraryCPI(lines, idx);
    case 5: return fixTypeConfusion(lines, idx);
    case 6: return fixReinitialization(lines, idx);
    case 7: return fixCloseThenRevive(lines, idx);
    case 9: return fixIntegerOverflow(lines, idx);
    case 14: return fixStaleCPIRead(lines, idx);
    default:
      if (f.fixPlan?.code) {
        const indent = lines[idx].match(/^(\s*)/)?.[1] || "";
        const codeLines = f.fixPlan.code.split("\n").map((l) => indent + l.trimStart());
        lines.splice(idx, 1, ...codeLines);
        return lines.join("\n");
      }
      return null;
  }
}

function fixMissingSigner(lines: string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    if (
      (lines[i].includes("pub authority") ||
        lines[i].includes("pub admin") ||
        lines[i].includes("pub owner") ||
        lines[i].includes("pub payer")) &&
      !lines
        .slice(Math.max(0, i - 3), i)
        .join("\n")
        .includes("signer")
    ) {
      const prevLines = lines.slice(Math.max(0, i - 3), i).join("\n");
      if (prevLines.includes("#[account(")) {
        for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
          if (lines[j].includes("#[account(")) {
            lines[j] = lines[j].replace("#[account(", "#[account(signer, ");
            return lines.join("\n");
          }
        }
      } else {
        const indent = lines[i].match(/^(\s*)/)?.[1] || "    ";
        lines.splice(i, 0, `${indent}#[account(signer)]`);
        return lines.join("\n");
      }
    }
  }
  return null;
}

function fixMissingOwner(lines: string[], idx: number): string | null {
  const line = lines[idx];
  if (line.includes("#[account(") && !line.includes("has_one") && !line.includes("owner")) {
    lines[idx] = line.replace("#[account(", "#[account(has_one = authority, ");
    return lines.join("\n");
  }
  return null;
}

function fixPDADerivation(lines: string[], idx: number): string | null {
  for (let i = Math.max(0, idx - 5); i < Math.min(lines.length, idx + 5); i++) {
    if (
      lines[i].includes("seeds") &&
      lines[i].includes("=") &&
      !lines
        .slice(i, i + 5)
        .join("\n")
        .includes("bump")
    ) {
      if (lines[i].includes("]")) {
        lines[i] = lines[i].replace("]", ", bump]");
      }
      return lines.join("\n");
    }
  }
  return null;
}

function fixArbitraryCPI(lines: string[], idx: number): string | null {
  for (let i = Math.max(0, idx - 2); i < Math.min(lines.length, idx + 5); i++) {
    if (lines[i].includes("invoke") || lines[i].includes("CpiContext")) {
      const indent = lines[i].match(/^(\s*)/)?.[1] || "        ";
      const surroundingCode = lines.slice(Math.max(0, i - 5), i).join("\n");
      if (!surroundingCode.includes("require!") || !surroundingCode.includes("InvalidProgram")) {
        lines.splice(
          i,
          0,
          `${indent}require!(ctx.accounts.target_program.key() == expected_program::ID, ErrorCode::InvalidProgram);`
        );
        return lines.join("\n");
      }
    }
  }
  return null;
}

function fixTypeConfusion(lines: string[], idx: number): string | null {
  const line = lines[idx];
  if (line.includes("AccountInfo") && !line.includes("Account<")) {
    lines[idx] = line.replace(/AccountInfo<'info>/, "Account<'info, YourAccountType>");
    return lines.join("\n");
  }
  return null;
}

function fixReinitialization(lines: string[], idx: number): string | null {
  for (let i = Math.max(0, idx - 5); i < Math.min(lines.length, idx + 5); i++) {
    if (lines[i].includes("#[account(") && lines[i].includes("init")) {
      const nearbyCode = lines.slice(i, Math.min(lines.length, i + 5)).join("\n");
      if (!nearbyCode.includes("constraint") || !nearbyCode.includes("initialized")) {
        const indent = lines[i].match(/^(\s*)/)?.[1] || "    ";
        lines.splice(
          i + 1,
          0,
          `${indent}    constraint = !account.is_initialized @ ErrorCode::AlreadyInitialized,`
        );
        return lines.join("\n");
      }
    }
  }
  return null;
}

function fixCloseThenRevive(lines: string[], idx: number): string | null {
  for (let i = Math.max(0, idx - 3); i < Math.min(lines.length, idx + 10); i++) {
    if (lines[i].includes("close") || (lines[i].includes("lamports()") && lines[i].includes("= 0"))) {
      const indent = lines[i].match(/^(\s*)/)?.[1] || "        ";
      const afterClose = lines.slice(i + 1, Math.min(lines.length, i + 5)).join("\n");
      if (!afterClose.includes("discriminator") && !afterClose.includes("fill(0)")) {
        lines.splice(
          i + 1,
          0,
          `${indent}// Zero discriminator to prevent account revival`,
          `${indent}let data = account.try_borrow_mut_data()?;`,
          `${indent}data[..8].fill(0);`
        );
        return lines.join("\n");
      }
    }
  }
  return null;
}

function fixIntegerOverflow(lines: string[], idx: number): string | null {
  let line = lines[idx];
  const orig = line;
  line = line.replace(/(\w+)\s*\+\s*(\w+)(?!\s*\))/g, "$1.checked_add($2).ok_or(ErrorCode::Overflow)?");
  line = line.replace(/(\w+)\s*-\s*(\w+)(?!\s*\))/g, "$1.checked_sub($2).ok_or(ErrorCode::Underflow)?");
  line = line.replace(/(\w+)\s*\*\s*(\w+)(?!\s*\))/g, "$1.checked_mul($2).ok_or(ErrorCode::Overflow)?");
  line = line.replace(/(\w+)\s*\/\s*(\w+)(?!\s*\))/g, "$1.checked_div($2).ok_or(ErrorCode::DivisionByZero)?");
  if (line !== orig) {
    lines[idx] = line;
    return lines.join("\n");
  }
  return null;
}

function fixStaleCPIRead(lines: string[], idx: number): string | null {
  for (let i = Math.max(0, idx - 2); i < Math.min(lines.length, idx + 5); i++) {
    if (lines[i].includes("invoke") || lines[i].includes("transfer") || lines[i].includes("CpiContext")) {
      const indent = lines[i].match(/^(\s*)/)?.[1] || "        ";
      const afterCPI = lines.slice(i + 1, Math.min(lines.length, i + 10)).join("\n");
      const m = afterCPI.match(/ctx\.accounts\.(\w+)/);
      if (m) {
        lines.splice(i + 1, 0, `${indent}ctx.accounts.${m[1]}.reload()?;`);
        return lines.join("\n");
      }
    }
  }
  return null;
}

/**
 * Generate a unified diff between two strings
 */
function makeDiff(file: string, orig: string, patched: string): string {
  const a = orig.split("\n");
  const b = patched.split("\n");
  const out = [`--- a/${file}`, `+++ b/${file}`];

  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    const start = Math.max(0, i - 3);
    const hunks: string[] = [];
    for (let c = start; c < i; c++) hunks.push(` ${a[c]}`);
    while (i < a.length && (j >= b.length || a[i] !== b[j])) {
      hunks.push(`-${a[i]}`);
      i++;
    }
    while (j < b.length && (i >= a.length || a[i] !== b[j])) {
      hunks.push(`+${b[j]}`);
      j++;
    }
    out.push(`@@ -${start + 1} +${start + 1} @@`, ...hunks);
  }

  return out.join("\n");
}
