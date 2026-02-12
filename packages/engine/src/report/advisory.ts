import type { FindingResult, AuditSummary, ParsedProgram, AuditGraph } from "../types";
import type { CodePatch } from "../remediation/patcher";
import type { PoCResult } from "../proof/executor";

export interface AdvisoryOptions {
  agentName?: string;
  agentVersion?: string;
  repoUrl: string;
  repoMeta?: { stars?: number; forks?: number; framework?: string };
  patches?: CodePatch[];
  pocResults?: PoCResult[];
}

/**
 * Generate a professional security advisory document (Markdown)
 * suitable for Solana Foundation bounty submission.
 */
export function generateSecurityAdvisory(
  program: ParsedProgram,
  findings: FindingResult[],
  summary: AuditSummary,
  graphs: AuditGraph[],
  opts: AdvisoryOptions
): string {
  const agent = opts.agentName || "solaudit-agent";
  const ver = opts.agentVersion || "1.0.0";
  const now = new Date().toISOString().split("T")[0];
  const critical = findings.filter((f) => f.severity === "CRITICAL");
  const high = findings.filter((f) => f.severity === "HIGH");
  const actionable = [...critical, ...high];

  const s: string[] = [];

  // ── Header ──
  s.push(`# Security Audit Report: ${program.name}

**Repository:** ${opts.repoUrl}
**Date:** ${now}
**Agent:** ${agent} v${ver}
**Framework:** ${program.framework}
**Verdict:** ${summary.shipReady ? "SHIP READY" : "DO NOT SHIP"}

---
`);

  // ── Executive Summary ──
  s.push(`## Executive Summary

Automated security audit of **${program.name}** (${program.framework}) identified **${summary.totalFindings} finding(s)** across ${program.instructions.length} instruction(s) and ${program.accounts.length} account struct(s).

| Severity | Count |
|----------|-------|
| Critical | ${summary.criticalCount} |
| High | ${summary.highCount} |
| Medium | ${summary.mediumCount} |
| Low | ${summary.lowCount} |
| Info | ${summary.infoCount} |

**Recommendation:** ${summary.recommendation}
`);

  // ── Methodology ──
  s.push(`## Methodology

The audit was performed by **${agent}**, an autonomous AI security agent using a 7-stage pipeline:

1. **Ingestion & Normalization** — Parse Rust/Anchor source, extract AST structures
2. **Semantic Graph Mining** — Build authority-flow, token-flow, state-machine, PDA graphs
3. **Candidate Generation** — 15 vulnerability detectors + constraint checker + adversarial synthesis
4. **Proof Construction** — Generate PoC exploit harnesses for each finding
5. **Remediation Planning** — Produce concrete code patches with regression tests
6. **Deduplication & Ranking** — Remove duplicates, rank by severity × confidence
7. **Report Assembly** — Generate this advisory and machine-readable JSON

### Vulnerability Classes

1. Missing signer check
2. Missing owner check
3. PDA derivation mistake
4. Arbitrary CPI target
5. Type confusion / account substitution
6. Reinitialization
7. Close-then-revive
8. Unchecked realloc / stale memory
9. Integer overflow/underflow
10. State machine violation
11. Remaining accounts injection
12. Oracle validation failure
13. Token account mismatch
14. Post-CPI stale read
15. Duplicate account injection
`);

  // ── Detailed Findings ──
  s.push(`## Findings\n`);

  for (let i = 0; i < actionable.length; i++) {
    const f = actionable[i];
    const poc = opts.pocResults?.find((p) => p.findingTitle === f.title);
    const patch = opts.patches?.find((p) => p.file === f.location.file);

    s.push(`### ${i + 1}. ${f.title}

| Field | Value |
|-------|-------|
| **Severity** | ${f.severity} |
| **Class** | #${f.classId} — ${f.className} |
| **Location** | \`${f.location.file}:${f.location.line}\`${f.location.instruction ? ` @ \`${f.location.instruction}\`` : ""} |
| **Confidence** | ${(f.confidence * 100).toFixed(0)}% |
| **Proof Status** | ${poc?.status || "PENDING"} |
`);

    // Impact
    if (f.hypothesis) {
      s.push(`#### Impact\n\n${f.hypothesis}\n`);
    }

    // Blast radius
    if (f.blastRadius) {
      s.push(`#### Blast Radius

- **Affected instructions:** ${f.blastRadius.affectedInstructions.join(", ") || "N/A"}
- **Affected accounts:** ${f.blastRadius.affectedAccounts.join(", ") || "N/A"}
- **Signer changes:** ${f.blastRadius.signerChanges.join(", ") || "N/A"}
`);
    }

    // Proof of Concept
    if (f.proofPlan) {
      s.push(`#### Proof of Concept\n`);
      if (f.proofPlan.steps?.length) {
        s.push(`**Steps:**\n\n${f.proofPlan.steps.map((st, j) => `${j + 1}. ${st}`).join("\n")}\n`);
      }
      if (f.proofPlan.harness) {
        s.push(`**Exploit harness:**\n\n\`\`\`rust\n${f.proofPlan.harness}\n\`\`\`\n`);
      }
      if (f.proofPlan.deltaSchema) {
        s.push(`**State delta:**
- Pre: \`${JSON.stringify(f.proofPlan.deltaSchema.preState)}\`
- Post: \`${JSON.stringify(f.proofPlan.deltaSchema.postState)}\`
- Assert: ${f.proofPlan.deltaSchema.assertion}
`);
      }
    }

    if (poc?.status === "proven" && poc.output) {
      s.push(`#### Verification Result\n\n\`\`\`\n${poc.output.slice(0, 2000)}\n\`\`\`\n`);
    }

    // Fix
    if (f.fixPlan) {
      s.push(`#### Recommended Fix\n\n**Pattern:** ${f.fixPlan.pattern}\n**Description:** ${f.fixPlan.description}\n`);
      if (patch) {
        s.push(`**Diff:**\n\n\`\`\`diff\n${patch.diff}\n\`\`\`\n`);
      } else if (f.fixPlan.code) {
        s.push(`**Code:**\n\n\`\`\`rust\n${f.fixPlan.code}\n\`\`\`\n`);
      }
      if (f.fixPlan.regressionTests?.length) {
        s.push(`**Regression tests:**\n\n${f.fixPlan.regressionTests.map((t) => `- ${t}`).join("\n")}\n`);
      }
    }

    s.push(`---\n`);
  }

  // ── Other findings ──
  const other = findings.filter((f) => !["CRITICAL", "HIGH"].includes(f.severity));
  if (other.length) {
    s.push(`## Additional Findings (Medium/Low/Info)\n`);
    s.push(`| # | Severity | Title | Location | Confidence |
|---|----------|-------|----------|------------|`);
    for (const f of other) {
      s.push(
        `| ${f.classId} | ${f.severity} | ${f.title} | \`${f.location.file}:${f.location.line}\` | ${(f.confidence * 100).toFixed(0)}% |`
      );
    }
    s.push("");
  }

  // ── Graph Analysis ──
  s.push(`## Semantic Graph Analysis\n`);
  for (const g of graphs) {
    s.push(`### ${g.name}\n\n- **Nodes:** ${g.nodes.length}\n- **Edges:** ${g.edges.length}\n`);
  }

  // ── Appendix ──
  s.push(`## Appendix

### Program Metadata

- **Name:** ${program.name}
- **Framework:** ${program.framework}
- **Program ID:** ${program.programId || "N/A"}
- **Instructions:** ${program.instructions.length}
- **Account Structs:** ${program.accounts.length}
- **CPI Calls:** ${program.cpiCalls.length}
- **PDA Derivations:** ${program.pdaDerivations.length}

### Files Analyzed

${program.files.map((f) => `- \`${f.path}\``).join("\n")}

### Disclaimer

This report was generated by an automated security analysis agent. While thorough,
it may contain false positives or miss certain vulnerability patterns. Manual review
by experienced Solana security engineers is recommended before production deployment.

---
*Generated by ${agent} v${ver} on ${now}*
`);

  return s.join("\n");
}

/**
 * Generate PR body from advisory findings
 */
export function generatePRBody(
  program: ParsedProgram,
  findings: FindingResult[],
  summary: AuditSummary,
  patches: CodePatch[],
  opts: AdvisoryOptions
): { title: string; body: string } {
  const c = findings.filter((f) => f.severity === "CRITICAL").length;
  const h = findings.filter((f) => f.severity === "HIGH").length;
  const n = c + h;

  const title = `fix: ${n} security issue${n !== 1 ? "s" : ""} found by solaudit-agent`;

  const body = `## Security Fix — solaudit-agent

### Summary

Automated security analysis of **${program.name}** found:

- **${c}** critical issue(s)
- **${h}** high severity issue(s)
- **${patches.length}** file(s) patched

### Findings Fixed

${findings
  .filter((f) => ["CRITICAL", "HIGH"].includes(f.severity))
  .map(
    (f, i) =>
      `${i + 1}. **[${f.severity}]** ${f.title} — \`${f.location.file}:${f.location.line}\`${
        f.location.instruction ? ` @ \`${f.location.instruction}\`` : ""
      }`
  )
  .join("\n")}

### Files Changed

${patches.map((p) => `- \`${p.file}\` — ${p.description}`).join("\n")}

### How to Verify

1. Review each changed file for correctness
2. Run the existing test suite: \`anchor test\` or \`cargo test\`
3. Check that the fix addresses the root cause described above

---
*This PR was created by [solaudit-agent](https://github.com/grkhmz23/solaudit-agent), an autonomous Solana security audit AI agent.*
`;

  return { title, body };
}
