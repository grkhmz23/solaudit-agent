import { spawn } from "child_process";

// Start Next.js
const web = spawn("node", ["node_modules/.bin/next", "start", "-p", "3000"], {
  cwd: "./apps/web",
  stdio: "inherit",
  env: { ...process.env },
});

// Start Worker
const worker = spawn("node", ["apps/worker/dist/index.js"], {
  stdio: "inherit",
  env: { ...process.env },
});

// If either exits, kill both
web.on("exit", (code) => { console.log("[web] exited", code); process.exit(code ?? 1); });
worker.on("exit", (code) => { console.log("[worker] exited", code); process.exit(code ?? 1); });

process.on("SIGTERM", () => { web.kill(); worker.kill(); });
