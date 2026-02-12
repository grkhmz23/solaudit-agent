"use client";

import type { Finding } from "@/lib/hooks";
import { SeverityBadge, Card } from "@/components/ui";

export function FindingDetail({ finding }: { finding: Finding }) {
  return (
    <div className="space-y-4">
      {/* Header */}
      <Card>
        <div className="flex items-center gap-3 mb-3">
          <SeverityBadge severity={finding.severity} />
          <span className="text-xs font-mono text-gray-500">
            Class {finding.classId} — {finding.className}
          </span>
        </div>
        <h2 className="text-lg font-bold text-gray-100 mb-2">
          {finding.title}
        </h2>
        <p className="text-xs font-mono text-gray-400">
          {finding.location.file}:{finding.location.line}
          {finding.location.instruction
            ? ` — instruction: ${finding.location.instruction}`
            : ""}
        </p>
        <div className="mt-3 flex items-center gap-4 text-sm">
          <span className="text-gray-500">
            Confidence:{" "}
            <span className="text-gray-300">
              {(finding.confidence * 100).toFixed(0)}%
            </span>
          </span>
          <span className="text-gray-500">
            Proof:{" "}
            <span className="text-gray-300">{finding.proofStatus}</span>
          </span>
        </div>
      </Card>

      {/* Exploit Hypothesis */}
      {finding.hypothesis && (
        <Card>
          <h3 className="text-sm font-medium text-gray-300 mb-2">
            Exploit Hypothesis
          </h3>
          <p className="text-sm text-gray-400 leading-relaxed">
            {finding.hypothesis}
          </p>
        </Card>
      )}

      {/* Proof Plan */}
      {finding.proofPlan && (
        <Card>
          <h3 className="text-sm font-medium text-gray-300 mb-3">
            Proof Plan
          </h3>

          {finding.proofPlan.steps && (
            <ol className="list-decimal list-inside space-y-1 text-sm text-gray-400 mb-4">
              {finding.proofPlan.steps.map((step: string, i: number) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          )}

          {finding.proofPlan.harnessType && (
            <p className="text-xs text-gray-500 mb-2">
              Harness type:{" "}
              <span className="text-gray-300">
                {finding.proofPlan.harnessType}
              </span>
            </p>
          )}

          {finding.proofPlan.deltaSchema && (
            <div className="mt-3 p-3 bg-gray-900 rounded border border-gray-800 text-xs font-mono">
              <p className="text-gray-500 mb-1">Delta Schema:</p>
              <p className="text-gray-400">
                Pre:{" "}
                {JSON.stringify(finding.proofPlan.deltaSchema.preState)}
              </p>
              <p className="text-gray-400">
                Post:{" "}
                {JSON.stringify(finding.proofPlan.deltaSchema.postState)}
              </p>
              <p className="text-green-400 mt-1">
                Assert: {finding.proofPlan.deltaSchema.assertion}
              </p>
            </div>
          )}

          {finding.proofPlan.harness && (
            <details className="mt-3">
              <summary className="text-xs text-green-400 cursor-pointer hover:text-green-300">
                View generated harness
              </summary>
              <pre className="mt-2 p-3 bg-gray-900 rounded border border-gray-800 text-xs font-mono text-gray-400 overflow-x-auto whitespace-pre-wrap">
                {finding.proofPlan.harness}
              </pre>
            </details>
          )}

          {finding.proofPlan.requiredCommands &&
            finding.proofPlan.requiredCommands.length > 0 && (
              <div className="mt-3 text-xs text-gray-500">
                <p>Required commands to execute proof:</p>
                <ul className="list-disc list-inside mt-1">
                  {finding.proofPlan.requiredCommands.map(
                    (cmd: string, i: number) => (
                      <li key={i} className="font-mono text-gray-400">
                        {cmd}
                      </li>
                    )
                  )}
                </ul>
              </div>
            )}
        </Card>
      )}

      {/* Fix Plan */}
      {finding.fixPlan && (
        <Card>
          <h3 className="text-sm font-medium text-gray-300 mb-2">
            Remediation
          </h3>
          <p className="text-sm text-gray-400 mb-3">
            {finding.fixPlan.description}
          </p>

          {finding.fixPlan.code && (
            <pre className="p-3 bg-gray-900 rounded border border-gray-800 text-xs font-mono text-gray-400 overflow-x-auto whitespace-pre-wrap">
              {finding.fixPlan.code}
            </pre>
          )}

          {finding.fixPlan.regressionTests &&
            finding.fixPlan.regressionTests.length > 0 && (
              <div className="mt-3">
                <p className="text-xs text-gray-500 mb-1">
                  Regression Tests:
                </p>
                <ul className="list-disc list-inside text-xs text-gray-400">
                  {finding.fixPlan.regressionTests.map(
                    (test: string, i: number) => (
                      <li key={i}>{test}</li>
                    )
                  )}
                </ul>
              </div>
            )}
        </Card>
      )}

      {/* Blast Radius */}
      {finding.blastRadius && (
        <Card>
          <h3 className="text-sm font-medium text-gray-300 mb-2">
            Blast Radius
          </h3>
          {finding.blastRadius.affectedAccounts?.length > 0 && (
            <div className="mb-2">
              <p className="text-xs text-gray-500">Affected Accounts:</p>
              <div className="flex flex-wrap gap-1 mt-1">
                {finding.blastRadius.affectedAccounts.map(
                  (acc: string, i: number) => (
                    <span
                      key={i}
                      className="text-xs px-2 py-0.5 bg-gray-800 rounded font-mono text-gray-300"
                    >
                      {acc}
                    </span>
                  )
                )}
              </div>
            </div>
          )}
          {finding.blastRadius.affectedInstructions?.length > 0 && (
            <div>
              <p className="text-xs text-gray-500">
                Affected Instructions:
              </p>
              <div className="flex flex-wrap gap-1 mt-1">
                {finding.blastRadius.affectedInstructions.map(
                  (instr: string, i: number) => (
                    <span
                      key={i}
                      className="text-xs px-2 py-0.5 bg-gray-800 rounded font-mono text-gray-300"
                    >
                      {instr}
                    </span>
                  )
                )}
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
