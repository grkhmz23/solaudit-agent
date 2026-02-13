import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { validateApiKey, errorResponse } from '@/lib/api-key';
import { enqueueAudit } from '@/lib/queue';
import crypto from 'crypto';

export async function POST(req: NextRequest) {
  const authErr = validateApiKey(req);
  if (authErr) return authErr;
  try {
    const body = await req.json();
    const { mode, repos, minStars, maxRepos, submitPRs } = body;
    if (mode === 'discover') {
      const id = crypto.randomUUID();
      await prisma.auditJob.create({
        data: { id, repoUrl: 'agent://discover', repoSource: 'agent', mode: 'FIX_PLAN', status: 'QUEUED', repoMeta: {} },
      });
      await enqueueAudit({
        auditJobId: id, mode: 'FIX_PLAN', repoSource: 'agent', repoUrl: 'agent://discover',
        agentConfig: { type: 'discover', minStars, maxRepos, submitPRs },
      });
      return NextResponse.json({ jobId: id, status: 'queued' });
    }
    if (mode === 'audit' && repos?.length > 0) {
      const jobs = [];
      for (const repoUrl of repos.slice(0, 10)) {
        const id = crypto.randomUUID();
        await prisma.auditJob.create({
          data: { id, repoUrl, repoSource: 'url', mode: 'FIX_PLAN', status: 'QUEUED', repoMeta: {} },
        });
        await enqueueAudit({
          auditJobId: id, mode: 'FIX_PLAN', repoSource: 'url', repoUrl,
          agentConfig: { type: 'audit', submitPRs },
        });
        jobs.push({ jobId: id, repoUrl });
      }
      return NextResponse.json({ jobs, status: 'queued' });
    }
    return NextResponse.json({ error: 'Invalid mode' }, { status: 400 });
  } catch (err: any) {
    console.error('POST /api/agent error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const authErr = validateApiKey(req);
  if (authErr) return authErr;
  try {
    const jobs = await prisma.auditJob.findMany({
      where: { OR: [{ repoSource: 'agent' }, { mode: 'FIX_PLAN' }] },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return NextResponse.json({ jobs });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}