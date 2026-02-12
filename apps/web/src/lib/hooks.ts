"use client";

import { useState, useEffect, useCallback, useRef } from "react";

export function getApiKey(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("solaudit_api_key") ?? "";
}

export function setApiKey(key: string) {
  localStorage.setItem("solaudit_api_key", key);
}

function headers(): HeadersInit {
  const key = getApiKey();
  return key ? { "x-api-key": key, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

async function apiFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...opts, headers: { ...headers(), ...opts?.headers } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

// ── Types ──

export interface AuditListItem {
  id: string;
  createdAt: string;
  status: string;
  mode: string;
  repoSource: string;
  repoUrl: string;
  progress: number | null;
  stageName: string | null;
  summary: any;
  findings: { id: string; severity: string; title: string; classId: number }[];
  _count: { findings: number; artifacts: number };
}

export interface AuditDetail {
  id: string;
  createdAt: string;
  status: string;
  mode: string;
  repoSource: string;
  repoUrl: string;
  repoMeta: any;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  progress: number | null;
  stageName: string | null;
  summary: any;
  findings: Finding[];
  artifacts: Artifact[];
}

export interface Finding {
  id: string;
  severity: string;
  classId: number;
  className: string;
  title: string;
  location: { file: string; line: number; instruction?: string };
  confidence: number;
  hypothesis: string | null;
  proofStatus: string;
  proofPlan: any;
  proofArtifacts: any;
  fixPlan: any;
  blastRadius: any;
}

export interface Artifact {
  id: string;
  type: string;
  name: string;
  contentType: string;
  metadata: any;
  sizeBytes: number | null;
  createdAt: string;
}

// ── Hooks ──

export function useAudits(pollMs = 5000) {
  const [audits, setAudits] = useState<AuditListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const data = await apiFetch<{ audits: AuditListItem[]; total: number }>("/api/audits?limit=50");
      setAudits(data.audits);
      setTotal(data.total);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch_();
    const interval = setInterval(fetch_, pollMs);
    return () => clearInterval(interval);
  }, [fetch_, pollMs]);

  return { audits, total, loading, error, refetch: fetch_ };
}

export function useAudit(id: string, pollMs = 3000) {
  const [audit, setAudit] = useState<AuditDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const shouldPoll = useRef(true);

  const fetch_ = useCallback(async () => {
    try {
      const data = await apiFetch<{ audit: AuditDetail }>(`/api/audits/${id}`);
      setAudit(data.audit);
      setError(null);
      if (["SUCCEEDED", "FAILED"].includes(data.audit.status)) {
        shouldPoll.current = false;
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    shouldPoll.current = true;
    fetch_();
    const interval = setInterval(() => {
      if (shouldPoll.current) fetch_();
    }, pollMs);
    return () => clearInterval(interval);
  }, [fetch_, pollMs]);

  return { audit, loading, error, refetch: fetch_ };
}

export async function createAudit(data: { repoUrl?: string; mode: string }): Promise<{ audit: { id: string } }> {
  return apiFetch("/api/audits", { method: "POST", body: JSON.stringify(data) });
}

export async function getArtifactUrl(artifactId: string): Promise<{ url: string; name: string; contentType: string }> {
  return apiFetch(`/api/artifacts/${artifactId}/url`);
}

export async function fetchQueueHealth(): Promise<{ redis: string; database: string; timestamp: string }> {
  const data = await apiFetch<{ status: string; checks: Record<string, string> }>("/api/health");
  return { redis: data.checks?.redis ?? "unknown", database: data.checks?.database ?? "unknown", timestamp: new Date().toISOString() };
}

export async function fetchQueueStats(): Promise<{ waiting: number; active: number; completed: number; failed: number }> {
  const data = await apiFetch<{ counts: Record<string, number> }>("/api/queue");
  return { waiting: data.counts?.waiting ?? 0, active: data.counts?.active ?? 0, completed: data.counts?.completed ?? 0, failed: data.counts?.failed ?? 0 };
}
