import { spawn } from "child_process";

const web = spawn("npx", ["next", "start", "-p", "3000"], {
  cwd: "./apps/web",
  stdio: "inherit",
  env: { ...process.env },
});

const worker = spawn("node", ["apps/worker/dist/index.js"], {
  stdio: "inherit",
  env: { ...process.env },
});

web.on("exit", (code) => { console.log("[web] exited", code); process.exit(code ?? 1); });
worker.on("exit", (code) => { console.log("[worker] exited", code); process.exit(code ?? 1); });
process.on("SIGTERM", () => { web.kill(); worker.kill(); });
