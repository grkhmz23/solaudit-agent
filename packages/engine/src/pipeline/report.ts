import type { FindingResult, AuditSummary, AuditGraph, ParsedProgram } from "../types";

export function generateMarkdownReport(
  program: ParsedProgram,
  findings: FindingResult[],
  summary: AuditSummary,
  graphs: AuditGraph[]
): string {
  const severityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };
  const sorted = [...findings].sort(
    (a, b) => severityOrder[a.severity] - severityOrder[b.severity]
  );

  const lines: string[] = [];

  lines.push(`# Solana Audit Report: ${program.name}`);
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Framework:** ${program.framework}`);
  if (program.programId) lines.push(`**Program ID:** \`${program.programId}\``);
  lines.push(`**Instructions:** ${program.instructions.length}`);
  lines.push(`**Account Structs:** ${program.accounts.length}`);
  lines.push("");

  // Executive Summary
  lines.push("## Executive Summary");
  lines.push("");
  lines.push(
    summary.shipReady
      ? "**Verdict: SHIP** — No critical or high severity issues found."
      : "**Verdict: DO NOT SHIP** — Critical issues must be resolved before deployment."
  );
  lines.push("");
  lines.push(`| Severity | Count |`);
  lines.push(`|----------|-------|`);
  lines.push(`| Critical | ${summary.criticalCount} |`);
  lines.push(`| High     | ${summary.highCount} |`);
  lines.push(`| Medium   | ${summary.mediumCount} |`);
  lines.push(`| Low      | ${summary.lowCount} |`);
  lines.push(`| Info     | ${summary.infoCount} |`);
  lines.push(`| **Total** | **${summary.totalFindings}** |`);
  lines.push("");
  lines.push(`**Recommendation:** ${summary.recommendation}`);
  lines.push("");

  // Findings
  lines.push("## Findings");
  lines.push("");

  for (const finding of sorted) {
    const emoji =
      finding.severity === "CRITICAL" ? "🔴"
        : finding.severity === "HIGH" ? "🟠"
          : finding.severity === "MEDIUM" ? "🟡"
            : finding.severity === "LOW" ? "🔵"
              : "⚪";

    lines.push(
      `### ${emoji} [${finding.severity}] ${finding.title}`
    );
    lines.push("");
    lines.push(`**Class:** ${finding.classId} — ${finding.className}`);
    lines.push(
      `**Location:** \`${finding.location.file}:${finding.location.line}\``
    );
    if (finding.location.instruction) {
      lines.push(`**Instruction:** \`${finding.location.instruction}\``);
    }
    lines.push(`**Confidence:** ${(finding.confidence * 100).toFixed(0)}%`);
    lines.push("");

    if (finding.hypothesis) {
      lines.push("**Exploit Hypothesis:**");
      lines.push(finding.hypothesis);
      lines.push("");
    }

    if (finding.proofPlan) {
      lines.push("**Proof Plan:**");
      for (const step of finding.proofPlan.steps) {
        lines.push(`1. ${step}`);
      }
      lines.push("");

      if (finding.proofPlan.deltaSchema) {
        lines.push("**Delta Schema:**");
        lines.push(`- Pre:  \`${JSON.stringify(finding.proofPlan.deltaSchema.preState)}\``);
        lines.push(`- Post: \`${JSON.stringify(finding.proofPlan.deltaSchema.postState)}\``);
        lines.push(`- Assert: ${finding.proofPlan.deltaSchema.assertion}`);
        lines.push("");
      }
    }

    if (finding.fixPlan) {
      lines.push("**Remediation:**");
      lines.push(finding.fixPlan.description);
      if (finding.fixPlan.code) {
        lines.push("```rust");
        lines.push(finding.fixPlan.code);
        lines.push("```");
      }
      if (finding.fixPlan.regressionTests?.length) {
        lines.push("**Regression Tests:**");
        for (const test of finding.fixPlan.regressionTests) {
          lines.push(`- ${test}`);
        }
      }
      lines.push("");
    }

    if (finding.blastRadius) {
      lines.push("**Blast Radius:**");
      if (finding.blastRadius.affectedAccounts.length > 0) {
        lines.push(
          `- Affected accounts: ${finding.blastRadius.affectedAccounts.join(", ")}`
        );
      }
      if (finding.blastRadius.affectedInstructions.length > 0) {
        lines.push(
          `- Affected instructions: ${finding.blastRadius.affectedInstructions.join(", ")}`
        );
      }
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  // Graphs summary
  if (graphs.length > 0) {
    lines.push("## Graph Analysis");
    lines.push("");
    for (const graph of graphs) {
      lines.push(`### ${graph.name}`);
      lines.push(`- Nodes: ${graph.nodes.length}`);
      lines.push(`- Edges: ${graph.edges.length}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function generateJsonReport(
  program: ParsedProgram,
  findings: FindingResult[],
  summary: AuditSummary,
  graphs: AuditGraph[]
): object {
  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      engineVersion: "1.0.0",
      programName: program.name,
      programId: program.programId,
      framework: program.framework,
      instructionCount: program.instructions.length,
      accountStructCount: program.accounts.length,
    },
    summary,
    findings: findings.map((f) => ({
      classId: f.classId,
      className: f.className,
      severity: f.severity,
      title: f.title,
      location: f.location,
      confidence: f.confidence,
      hypothesis: f.hypothesis,
      proofPlan: f.proofPlan,
      fixPlan: f.fixPlan,
      blastRadius: f.blastRadius,
    })),
    graphs: graphs.map((g) => ({
      name: g.name,
      nodeCount: g.nodes.length,
      edgeCount: g.edges.length,
      nodes: g.nodes,
      edges: g.edges,
    })),
  };
}
