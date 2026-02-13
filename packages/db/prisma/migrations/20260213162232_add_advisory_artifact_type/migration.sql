-- CreateEnum
CREATE TYPE "AuditStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "AuditMode" AS ENUM ('SCAN', 'PROVE', 'FIX_PLAN');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');

-- CreateEnum
CREATE TYPE "ProofStatus" AS ENUM ('PENDING', 'PLANNED', 'RUNNING', 'PROVEN', 'DISPROVEN', 'SKIPPED', 'ERROR');

-- CreateEnum
CREATE TYPE "ArtifactType" AS ENUM ('LOG', 'SNAPSHOT', 'GRAPH', 'REPORT', 'PROOF_PLAN', 'PROOF_OUTPUT', 'ADVISORY');

-- CreateTable
CREATE TABLE "AuditJob" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" "AuditStatus" NOT NULL DEFAULT 'QUEUED',
    "mode" "AuditMode" NOT NULL,
    "repoSource" TEXT NOT NULL,
    "repoUrl" TEXT,
    "repoMeta" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "progress" INTEGER NOT NULL DEFAULT 0,
    "stageName" TEXT,
    "summary" JSONB,

    CONSTRAINT "AuditJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Finding" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "auditJobId" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "classId" INTEGER NOT NULL,
    "className" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "location" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "hypothesis" TEXT,
    "proofStatus" "ProofStatus" NOT NULL DEFAULT 'PENDING',
    "proofPlan" JSONB,
    "proofArtifacts" JSONB,
    "fixPlan" JSONB,
    "blastRadius" JSONB,

    CONSTRAINT "Finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "auditJobId" TEXT NOT NULL,
    "type" "ArtifactType" NOT NULL,
    "name" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "sha256" TEXT,
    "metadata" JSONB,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditJob_status_idx" ON "AuditJob"("status");

-- CreateIndex
CREATE INDEX "AuditJob_createdAt_idx" ON "AuditJob"("createdAt");

-- CreateIndex
CREATE INDEX "Finding_auditJobId_idx" ON "Finding"("auditJobId");

-- CreateIndex
CREATE INDEX "Finding_severity_idx" ON "Finding"("severity");

-- CreateIndex
CREATE INDEX "Finding_classId_idx" ON "Finding"("classId");

-- CreateIndex
CREATE INDEX "Artifact_auditJobId_idx" ON "Artifact"("auditJobId");

-- CreateIndex
CREATE INDEX "Artifact_type_idx" ON "Artifact"("type");

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_auditJobId_fkey" FOREIGN KEY ("auditJobId") REFERENCES "AuditJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_auditJobId_fkey" FOREIGN KEY ("auditJobId") REFERENCES "AuditJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
