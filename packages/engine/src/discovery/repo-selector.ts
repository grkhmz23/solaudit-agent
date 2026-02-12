/**
 * Repo Discovery & Selection Intelligence
 *
 * Selects high-value Solana repos based on:
 * - GitHub stars (proxy for popularity)
 * - Recent activity (recently updated = maintained = more valuable)
 * - Known DeFi protocols (higher TVL = higher impact)
 */

export interface RepoCandidate {
  owner: string;
  repo: string;
  url: string;
  stars: number;
  forks: number;
  description: string | null;
  topics: string[];
  framework: "anchor" | "native" | "unknown";
  updatedAt: string;
  score: number;
  reason: string;
}

const KNOWN_PROTOCOLS = [
  { owner: "marinade-finance", repo: "liquid-staking-program", category: "liquid-staking", tvl: "high" as const },
  { owner: "solana-labs", repo: "solana-program-library", category: "core", tvl: "high" as const },
  { owner: "orca-so", repo: "whirlpools", category: "dex", tvl: "high" as const },
  { owner: "raydium-io", repo: "raydium-amm", category: "dex", tvl: "high" as const },
  { owner: "drift-labs", repo: "protocol-v2", category: "perps", tvl: "high" as const },
  { owner: "jito-foundation", repo: "jito-programs", category: "liquid-staking", tvl: "high" as const },
  { owner: "openbook-dex", repo: "openbook-v2", category: "dex", tvl: "high" as const },
  { owner: "coral-xyz", repo: "anchor", category: "framework", tvl: "high" as const },
  { owner: "solend-protocol", repo: "solend-sdk", category: "lending", tvl: "high" as const },
  { owner: "squads-protocol", repo: "v4", category: "multisig", tvl: "medium" as const },
  { owner: "switchboard-xyz", repo: "switchboard-v2", category: "oracle", tvl: "medium" as const },
  { owner: "metaplex-foundation", repo: "mpl-token-metadata", category: "nft", tvl: "medium" as const },
  { owner: "pyth-network", repo: "pyth-sdk-solana", category: "oracle", tvl: "medium" as const },
  { owner: "helium", repo: "helium-program-library", category: "depin", tvl: "medium" as const },
  { owner: "clockwork-xyz", repo: "clockwork", category: "automation", tvl: "low" as const },
  { owner: "hubbleprotocol", repo: "hubble-common", category: "lending", tvl: "medium" as const },
  { owner: "tensor-hq", repo: "tensor-contracts", category: "nft", tvl: "medium" as const },
];

/**
 * Score a repository based on bounty-relevant criteria
 */
export function scoreRepo(repo: {
  stars: number;
  forks: number;
  topics: string[];
  updatedAt: string;
  owner: string;
  name: string;
}): { score: number; reason: string } {
  let score = 0;
  const reasons: string[] = [];

  // Stars weight
  if (repo.stars >= 1000) {
    score += 40;
    reasons.push("1K+ stars");
  } else if (repo.stars >= 500) {
    score += 30;
    reasons.push("500+ stars");
  } else if (repo.stars >= 100) {
    score += 20;
    reasons.push("100+ stars");
  } else if (repo.stars >= 50) {
    score += 10;
    reasons.push("50+ stars");
  }

  // Known protocol bonus
  const known = KNOWN_PROTOCOLS.find(
    (p) => p.owner === repo.owner || p.repo === repo.name
  );
  if (known) {
    const tvlBonus = known.tvl === "high" ? 25 : known.tvl === "medium" ? 15 : 5;
    score += tvlBonus;
    reasons.push(`known ${known.category} protocol (${known.tvl} TVL)`);
  }

  // Recency bonus
  const daysSinceUpdate = Math.floor(
    (Date.now() - new Date(repo.updatedAt).getTime()) / (1000 * 60 * 60 * 24)
  );
  if (daysSinceUpdate < 30) {
    score += 15;
    reasons.push("updated <30 days");
  } else if (daysSinceUpdate < 90) {
    score += 10;
    reasons.push("updated <90 days");
  } else if (daysSinceUpdate < 365) {
    score += 5;
  }

  // Forks
  if (repo.forks >= 100) {
    score += 10;
    reasons.push("100+ forks");
  } else if (repo.forks >= 50) {
    score += 5;
  }

  // Topic relevance
  const relevant = ["solana", "anchor", "defi", "dex", "lending", "staking", "nft", "dao"];
  const matched = repo.topics.filter((t) =>
    relevant.some((rt) => t.toLowerCase().includes(rt))
  );
  if (matched.length > 0) {
    score += matched.length * 3;
    reasons.push(`topics: ${matched.join(", ")}`);
  }

  return { score, reason: reasons.join("; ") };
}

export function getKnownProtocols() {
  return KNOWN_PROTOCOLS;
}

export function filterAuditableRepos(repos: RepoCandidate[]): RepoCandidate[] {
  return repos.filter((r) => {
    if (r.stars < 10) return false;
    return (
      r.topics.some((t) => t.includes("solana") || t.includes("anchor")) ||
      r.description?.toLowerCase().includes("solana") ||
      r.description?.toLowerCase().includes("anchor")
    );
  });
}

export function rankRepos(repos: RepoCandidate[]): RepoCandidate[] {
  return repos.sort((a, b) => b.score - a.score);
}
