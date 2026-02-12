import { Octokit } from "@octokit/rest";

export interface RepoRef { owner: string; repo: string; }
export interface PatchFile { path: string; content: string; }
export interface PRSubmission { title: string; body: string; patches: PatchFile[]; branch?: string; }
export interface PRResult { prUrl: string; prNumber: number; forkOwner: string; forkRepo: string; branch: string; }
export interface RepoInfo {
  owner: string; repo: string; fullName: string; stars: number; forks: number;
  language: string | null; description: string | null; topics: string[];
  defaultBranch: string; updatedAt: string; htmlUrl: string;
}

export class GitHubClient {
  private octokit: Octokit;
  private authenticatedUser: string | null = null;

  constructor(token?: string) {
    const t = token || process.env.GITHUB_TOKEN;
    if (!t) throw new Error("GITHUB_TOKEN required");
    this.octokit = new Octokit({ auth: t });
  }

  private async getUser(): Promise<string> {
    if (this.authenticatedUser) return this.authenticatedUser;
    const { data } = await this.octokit.users.getAuthenticated();
    this.authenticatedUser = data.login;
    return data.login;
  }

  static parseRepo(input: string): RepoRef {
    const m = input.match(/github\.com\/([^/]+)\/([^/.\s]+)/);
    if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
    const p = input.split("/");
    if (p.length === 2) return { owner: p[0], repo: p[1] };
    throw new Error(`Cannot parse repo: ${input}`);
  }

  async getRepoInfo(ref: RepoRef): Promise<RepoInfo> {
    const { data } = await this.octokit.repos.get({ owner: ref.owner, repo: ref.repo });
    return {
      owner: data.owner.login, repo: data.name, fullName: data.full_name,
      stars: data.stargazers_count, forks: data.forks_count,
      language: data.language, description: data.description,
      topics: data.topics || [], defaultBranch: data.default_branch,
      updatedAt: data.updated_at || "", htmlUrl: data.html_url,
    };
  }

  async forkRepo(ref: RepoRef): Promise<RepoRef> {
    const user = await this.getUser();
    // Check if fork already exists
    try {
      await this.octokit.repos.get({ owner: user, repo: ref.repo });
      return { owner: user, repo: ref.repo };
    } catch {
      // Fork doesn't exist, create it
    }

    const { data } = await this.octokit.repos.createFork({
      owner: ref.owner,
      repo: ref.repo,
    });

    // Wait for fork to be ready (GitHub forks are async)
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        await this.octokit.repos.get({ owner: user, repo: ref.repo });
        break;
      } catch {
        // Not ready yet
      }
    }

    return { owner: data.owner.login, repo: data.name };
  }

  async createBranch(fork: RepoRef, upstream: RepoRef, branch: string): Promise<string> {
    const { data: repo } = await this.octokit.repos.get({
      owner: upstream.owner,
      repo: upstream.repo,
    });

    const { data: ref } = await this.octokit.git.getRef({
      owner: upstream.owner,
      repo: upstream.repo,
      ref: `heads/${repo.default_branch}`,
    });

    // Sync fork
    try {
      await this.octokit.repos.mergeUpstream({
        owner: fork.owner,
        repo: fork.repo,
        branch: repo.default_branch,
      });
    } catch {
      // May fail if already up to date
    }

    // Create branch
    try {
      await this.octokit.git.createRef({
        owner: fork.owner,
        repo: fork.repo,
        ref: `refs/heads/${branch}`,
        sha: ref.object.sha,
      });
    } catch (e: any) {
      if (e.status === 422) {
        await this.octokit.git.updateRef({
          owner: fork.owner,
          repo: fork.repo,
          ref: `heads/${branch}`,
          sha: ref.object.sha,
          force: true,
        });
      } else {
        throw e;
      }
    }

    return branch;
  }

  async commitPatches(fork: RepoRef, branch: string, patches: PatchFile[], msg: string): Promise<string> {
    const { data: refData } = await this.octokit.git.getRef({
      owner: fork.owner,
      repo: fork.repo,
      ref: `heads/${branch}`,
    });
    const parentSha = refData.object.sha;

    const { data: parent } = await this.octokit.git.getCommit({
      owner: fork.owner,
      repo: fork.repo,
      commit_sha: parentSha,
    });

    // Create blobs
    const tree: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
    for (const p of patches) {
      const { data: blob } = await this.octokit.git.createBlob({
        owner: fork.owner,
        repo: fork.repo,
        content: Buffer.from(p.content).toString("base64"),
        encoding: "base64",
      });
      tree.push({ path: p.path, mode: "100644", type: "blob", sha: blob.sha });
    }

    const { data: newTree } = await this.octokit.git.createTree({
      owner: fork.owner,
      repo: fork.repo,
      tree,
      base_tree: parent.tree.sha,
    });

    const { data: commit } = await this.octokit.git.createCommit({
      owner: fork.owner,
      repo: fork.repo,
      message: msg,
      tree: newTree.sha,
      parents: [parentSha],
    });

    await this.octokit.git.updateRef({
      owner: fork.owner,
      repo: fork.repo,
      ref: `heads/${branch}`,
      sha: commit.sha,
    });

    return commit.sha;
  }

  async openPR(upstream: RepoRef, fork: RepoRef, branch: string, title: string, body: string): Promise<PRResult> {
    const { data: repo } = await this.octokit.repos.get({
      owner: upstream.owner,
      repo: upstream.repo,
    });

    const { data: pr } = await this.octokit.pulls.create({
      owner: upstream.owner,
      repo: upstream.repo,
      title,
      body,
      head: `${fork.owner}:${branch}`,
      base: repo.default_branch,
    });

    return {
      prUrl: pr.html_url,
      prNumber: pr.number,
      forkOwner: fork.owner,
      forkRepo: fork.repo,
      branch,
    };
  }

  /**
   * Full flow: fork → branch → commit patches → open PR
   */
  async submitFix(repoUrl: string, sub: PRSubmission): Promise<PRResult> {
    const upstream = GitHubClient.parseRepo(repoUrl);
    const branch = sub.branch || `solaudit/fix-${Date.now()}`;

    console.log(`[github] forking ${upstream.owner}/${upstream.repo}...`);
    const fork = await this.forkRepo(upstream);

    console.log(`[github] creating branch ${branch}...`);
    await this.createBranch(fork, upstream, branch);

    console.log(`[github] committing ${sub.patches.length} file(s)...`);
    await this.commitPatches(fork, branch, sub.patches, sub.title);

    console.log(`[github] opening PR...`);
    const result = await this.openPR(upstream, fork, branch, sub.title, sub.body);

    console.log(`[github] PR: ${result.prUrl}`);
    return result;
  }

  /**
   * Search for popular Solana repositories
   */
  async searchSolanaRepos(opts: { minStars?: number; maxResults?: number }): Promise<RepoInfo[]> {
    const min = opts.minStars ?? 50;
    const max = opts.maxResults ?? 30;
    const queries = [
      `solana program language:Rust stars:>=${min}`,
      `anchor-lang language:Rust stars:>=${min}`,
    ];

    const all = new Map<string, RepoInfo>();
    for (const q of queries) {
      try {
        const { data } = await this.octokit.search.repos({
          q,
          sort: "stars",
          order: "desc",
          per_page: Math.min(max, 100),
        });
        for (const item of data.items) {
          if (all.has(item.full_name)) continue;
          all.set(item.full_name, {
            owner: item.owner?.login || "",
            repo: item.name,
            fullName: item.full_name,
            stars: item.stargazers_count || 0,
            forks: item.forks_count || 0,
            language: item.language,
            description: item.description,
            topics: item.topics || [],
            defaultBranch: item.default_branch || "main",
            updatedAt: item.updated_at || "",
            htmlUrl: item.html_url,
          });
        }
      } catch (e: any) {
        console.warn(`[github] search failed: ${e.message}`);
      }
    }

    return [...all.values()].sort((a, b) => b.stars - a.stars).slice(0, max);
  }
}
