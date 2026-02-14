declare module "@solaudit/github" {
  export class GitHubClient {
    constructor(token: string);
    forkAndPR(params: {
      owner: string;
      repo: string;
      title: string;
      body: string;
      patches: Array<{ file: string; content: string }>;
      extraFiles?: Array<{ path: string; content: string }>;
      baseBranch?: string;
    }): Promise<{ prUrl: string; forkUrl: string }>;
    submitFix(repoUrl: string, params: {
      title: string;
      body: string;
      patches: Array<{ path: string; content: string }>;
      branch: string;
    }): Promise<{ prUrl: string }>;
  }
}
