import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  const job = await prisma.auditJob.create({
    data: {
      status: "SUCCEEDED",
      mode: "SCAN",
      repoSource: "url",
      repoUrl: "https://github.com/example/anchor-escrow",
      repoMeta: {
        name: "anchor-escrow",
        branch: "main",
        fileCount: 12,
      },
      startedAt: new Date(Date.now() - 120_000),
      finishedAt: new Date(),
      progress: 100,
      stageName: "complete",
      summary: {
        shipReady: false,
        totalFindings: 3,
        criticalCount: 1,
        highCount: 1,
        mediumCount: 1,
        lowCount: 0,
        recommendation:
          "Do not ship. 1 critical missing-signer-check must be resolved.",
      },
    },
  });

  await prisma.finding.createMany({
    data: [
      {
        auditJobId: job.id,
        severity: "CRITICAL",
        classId: 1,
        className: "Missing Signer Check",
        title: "withdraw instruction missing authority signer verification",
        location: {
          file: "programs/escrow/src/lib.rs",
          line: 45,
          endLine: 52,
          instruction: "withdraw",
        },
        confidence: 0.95,
        hypothesis:
          "Any account can call withdraw and drain escrow vault because authority is not validated as a signer.",
        proofStatus: "PLANNED",
        proofPlan: {
          steps: [
            "Create escrow with user A as authority",
            "Call withdraw with user B (non-authority) as signer",
            "Assert vault balance decreases",
          ],
        },
        fixPlan: {
          pattern: "add_signer_constraint",
          description:
            'Add `has_one = authority` and `#[account(signer)]` constraint to the authority account in the Withdraw context.',
          code: '#[account(signer, constraint = escrow.authority == authority.key())]',
        },
      },
      {
        auditJobId: job.id,
        severity: "HIGH",
        classId: 3,
        className: "PDA Derivation Mistake",
        title: "Escrow PDA uses insufficient seeds",
        location: {
          file: "programs/escrow/src/lib.rs",
          line: 20,
          endLine: 24,
          instruction: "initialize",
        },
        confidence: 0.85,
        hypothesis:
          "PDA derived with only [b\"escrow\"] seed allows collision between different users' escrows.",
        proofStatus: "PENDING",
        fixPlan: {
          pattern: "add_pda_seeds",
          description:
            "Include authority pubkey and a unique nonce in PDA seeds.",
          code: 'seeds = [b"escrow", authority.key().as_ref(), &nonce.to_le_bytes()]',
        },
      },
      {
        auditJobId: job.id,
        severity: "MEDIUM",
        classId: 6,
        className: "Reinitialization",
        title: "initialize instruction allows re-calling on existing escrow",
        location: {
          file: "programs/escrow/src/lib.rs",
          line: 10,
          endLine: 18,
          instruction: "initialize",
        },
        confidence: 0.78,
        hypothesis:
          "Escrow account can be re-initialized, resetting authority and allowing attacker to claim funds.",
        proofStatus: "PENDING",
        fixPlan: {
          pattern: "init_constraint",
          description:
            "Use Anchor `init` constraint which checks account is not already initialized.",
          code: "#[account(init, payer = authority, space = 8 + Escrow::INIT_SPACE)]",
        },
      },
    ],
  });

  await prisma.artifact.create({
    data: {
      auditJobId: job.id,
      type: "REPORT",
      name: "audit-report.md",
      path: "storage/reports/sample-report.md",
      metadata: { format: "markdown" },
      sizeBytes: 4096,
    },
  });

  console.log(`Seeded audit job: ${job.id} with 3 findings`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
