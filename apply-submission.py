#!/usr/bin/env python3
"""
Apply submission features on top of commit 14c5b71.
Adds: GitHub Gist writeup, writeupUrl, /submission endpoint, new stage meta.
"""
import os

def replace_in(path, old, new):
    content = open(path).read()
    if old not in content:
        print(f"  ⚠ Pattern not found in {path}, skipping")
        return False
    content = content.replace(old, new, 1)
    open(path, 'w').write(content)
    print(f"  ✅ {path}")
    return True

# ═══════════════════════════════════════════════════════════════
# 1. GitHub Client — add createGist + publishWriteup
# ═══════════════════════════════════════════════════════════════
print("\n1. Adding Gist support to GitHubClient...")
replace_in("packages/github/src/index.ts",
    '    console.log(`[github] PR: ${result.prUrl}`);\n    return result;\n  }\n\n  /**\n   * Search',
    '''    console.log(`[github] PR: ${result.prUrl}`);
    return result;
  }

  /**
   * Create a public GitHub Gist.
   */
  async createGist(
    filename: string,
    content: string,
    description: string,
    isPublic: boolean = true,
  ): Promise<{ gistUrl: string; rawUrl: string; gistId: string }> {
    const { data } = await this.octokit.gists.create({
      description,
      public: isPublic,
      files: { [filename]: { content } },
    });
    const file = data.files?.[filename];
    return {
      gistUrl: data.html_url || "",
      rawUrl: file?.raw_url || "",
      gistId: data.id || "",
    };
  }

  /**
   * Publish a bounty writeup as a public Gist.
   * Returns a permanent URL suitable for submission.
   */
  async publishWriteup(
    repoOwner: string,
    repoName: string,
    writeupMarkdown: string,
  ): Promise<{ gistUrl: string; rawUrl: string }> {
    const filename = `solaudit-${repoOwner}-${repoName}-writeup.md`;
    const description = `[SolAudit] Security audit writeup for ${repoOwner}/${repoName}`;
    console.log(`[github] Publishing writeup gist: ${filename}`);
    const result = await this.createGist(filename, writeupMarkdown, description, true);
    console.log(`[github] Writeup gist: ${result.gistUrl}`);
    return result;
  }

  /**
   * Search''')

# ═══════════════════════════════════════════════════════════════
# 2. Orchestrator — add writeupUrl + gist publish step
# ═══════════════════════════════════════════════════════════════
print("\n2. Adding writeupUrl to orchestrator...")
replace_in("packages/engine/src/agent/orchestrator.ts",
    "  submissionDoc: string | null;\n  prUrl: string | null;",
    "  submissionDoc: string | null;\n  prUrl: string | null;\n  writeupUrl: string | null;")

replace_in("packages/engine/src/agent/orchestrator.ts",
    "      submissionDoc: null,\n      prUrl: null,",
    "      submissionDoc: null,\n      prUrl: null,\n      writeupUrl: null,")

print("   Adding gist publish step after PR...")
replace_in("packages/engine/src/agent/orchestrator.ts",
    '''        } else if (config.submitPRs && validatedPatches.length === 0) {
          await progress("pr", "Skipped PR: no validated patches to submit");
        }

        await progress("done", `Completed ${repo.owner}/${repo.name}`);''',
    '''        } else if (config.submitPRs && validatedPatches.length === 0) {
          await progress("pr", "Skipped PR: no validated patches to submit");
        }

        // —— V2 Step 7: Publish writeup as GitHub Gist ——
        if (config.githubToken && run.submissionDoc) {
          await progress("writeup", "Publishing writeup to GitHub Gist...");
          try {
            const { GitHubClient } = await import("@solaudit/github");
            const gh = new GitHubClient(config.githubToken);
            const gist = await gh.publishWriteup(repo.owner, repo.name, run.submissionDoc);
            run.writeupUrl = gist.gistUrl;
            await progress("writeup", `Writeup published: ${gist.gistUrl}`);
          } catch (gistErr: any) {
            await progress("writeup_error", `Gist failed: ${gistErr.message}`);
          }
        }

        await progress("done", `Completed ${repo.owner}/${repo.name}`);''')

# ═══════════════════════════════════════════════════════════════
# 3. Agent handler — add writeupUrl + new stage pcts
# ═══════════════════════════════════════════════════════════════
print("\n3. Updating agent-handler...")
replace_in("apps/worker/src/agent-handler.ts",
    "        prUrl: run.prUrl || null,\n        durationMs: run.durationMs || null,",
    "        prUrl: run.prUrl || null,\n        writeupUrl: run.writeupUrl || null,\n        durationMs: run.durationMs || null,")

# Discover mode progress map
replace_in("apps/worker/src/agent-handler.ts",
    '''        clone: 20,
        audit: 28,
        pipeline: 36,
        patch: 44,
        poc: 48,
        llm: 55,
        poc_gen: 63,
        advisory: 70,
        submission_doc: 76,
        pr: 82,
        done: 90,''',
    '''        clone: 20,
        audit: 28,
        pipeline: 36,
        patch: 44,
        patch_author: 45,
        patch_validate: 48,
        patch_retry: 49,
        poc: 52,
        llm: 55,
        poc_gen: 63,
        advisory: 70,
        submission_doc: 76,
        pr: 82,
        writeup: 86,
        done: 90,''')

# Single repo mode progress map
replace_in("apps/worker/src/agent-handler.ts",
    '''        clone: 15,
        audit: 25,
        pipeline: 35,
        found: 40,
        patch: 45,
        poc: 50,
        llm: 58,
        poc_gen: 66,
        advisory: 72,
        submission_doc: 78,
        pr: 85,
        done: 95,''',
    '''        clone: 15,
        audit: 25,
        pipeline: 35,
        found: 40,
        patch: 45,
        patch_author: 47,
        patch_validate: 50,
        patch_retry: 52,
        poc: 55,
        llm: 58,
        poc_gen: 66,
        advisory: 72,
        submission_doc: 78,
        pr: 85,
        writeup: 90,
        done: 95,''')

# ═══════════════════════════════════════════════════════════════
# 4. Agent page — add new stage meta
# ═══════════════════════════════════════════════════════════════
print("\n4. Updating agent page UI stages...")
replace_in("apps/web/src/app/agent/page.tsx",
    '  "agent:patch":     { icon: "🔧", label: "Patching", color: "text-orange-400" },',
    '''  "agent:patch":     { icon: "🔧", label: "Patching", color: "text-orange-400" },
  "agent:patch_author": { icon: "🤖", label: "Kimi patch author", color: "text-pink-400" },
  "agent:patch_validate": { icon: "✔", label: "Patch validation", color: "text-amber-400" },
  "agent:patch_retry": { icon: "🔄", label: "Patch retry", color: "text-orange-400" },
  "agent:patch_error": { icon: "⚠", label: "Patch warning", color: "text-yellow-500" },''')

replace_in("apps/web/src/app/agent/page.tsx",
    '  "agent:pr_error":  { icon: "⚠", label: "PR warning", color: "text-yellow-500" },\n  "agent:done":',
    '  "agent:pr_error":  { icon: "⚠", label: "PR warning", color: "text-yellow-500" },\n  "agent:writeup":   { icon: "📝", label: "Writeup gist", color: "text-indigo-400" },\n  "agent:writeup_error": { icon: "⚠", label: "Writeup warning", color: "text-yellow-500" },\n  "agent:done":')

# ═══════════════════════════════════════════════════════════════
# 5. Submission endpoint — new file
# ═══════════════════════════════════════════════════════════════
print("\n5. Creating submission endpoint...")
sub_dir = "apps/web/src/app/api/audits/[id]/submission"
os.makedirs(sub_dir, exist_ok=True)
open(f"{sub_dir}/route.ts", 'w').write('''import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { validateApiKey, errorResponse } from "@/lib/api-key";
import { getStorage } from "@solaudit/storage";

/**
 * GET /api/audits/[id]/submission
 *
 * Returns submission-ready URLs for a completed audit:
 *   - prUrl: the PR link to the target repo (the fix)
 *   - writeupUrl: the writeup doc link (findings + impact + proof)
 *
 * These two URLs are what\\'s required for the "Audit & Fix" bounty submission.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authErr = validateApiKey(request);
  if (authErr) return authErr;

  try {
    const job = await prisma.auditJob.findUnique({
      where: { id: params.id },
      include: {
        artifacts: {
          where: {
            OR: [
              { metadata: { path: ["purpose"], equals: "bounty_submission" } },
              { type: "ADVISORY" },
              { name: { contains: "submission" } },
            ],
          },
        },
        findings: {
          orderBy: { severity: "asc" },
        },
      },
    });

    if (!job) {
      return errorResponse("Audit not found", 404);
    }

    if (job.status !== "SUCCEEDED") {
      return NextResponse.json(
        {
          ready: false,
          status: job.status,
          error: `Audit is ${job.status} — must be SUCCEEDED to submit`,
        },
        { status: 400 }
      );
    }

    const summary = job.summary as any;

    // Extract URLs from the run summaries
    let prUrl: string | null = null;
    let writeupUrl: string | null = null;

    if (summary?.runs) {
      for (const run of summary.runs) {
        if (run.prUrl) prUrl = run.prUrl;
        if (run.writeupUrl) writeupUrl = run.writeupUrl;
      }
    }

    // Fallback: get writeup from R2 signed URL
    let writeupR2Url: string | null = null;
    const writeupArtifact = job.artifacts.find(
      (a) =>
        a.name.includes("submission") ||
        (a.metadata as any)?.purpose === "bounty_submission"
    );

    if (writeupArtifact) {
      try {
        const storage = getStorage();
        writeupR2Url = await storage.getSignedUrl(writeupArtifact.objectKey, 86400);
      } catch {}
    }

    const ready = !!prUrl && !!(writeupUrl || writeupR2Url);
    const findingsSummary = job.findings.map((f) => ({
      severity: f.severity,
      title: f.title,
      classId: f.classId,
      className: f.className,
      confidence: f.confidence,
      proofStatus: f.proofStatus,
    }));

    return NextResponse.json({
      ready,
      auditId: job.id,
      repoUrl: job.repoUrl,
      status: job.status,
      prUrl,
      writeupUrl: writeupUrl || writeupR2Url,
      writeupGistUrl: writeupUrl,
      writeupR2Url,
      findings: findingsSummary,
      findingsCount: job.findings.length,
      message: ready
        ? "Submission ready. Use prUrl and writeupUrl for the bounty API call."
        : `Missing: ${!prUrl ? "PR link" : ""}${!prUrl && !(writeupUrl || writeupR2Url) ? " + " : ""}${!(writeupUrl || writeupR2Url) ? "writeup link" : ""}`,
    });
  } catch (err: any) {
    console.error("GET /api/audits/[id]/submission error:", err);
    return errorResponse("Failed to get submission info", 500);
  }
}
''')
print("  ✅ Created submission route")

print("\n✅ All submission features applied!")
print("\nNew pipeline flow:")
print("  Parse → Candidates → LLM Confirm → Kimi Patch → Validate → Advisory → PR → Gist Writeup")
print("\nAfter audit completes, call:")
print("  GET /api/audits/{id}/submission")
print("  → { prUrl, writeupUrl, ready: true }")
