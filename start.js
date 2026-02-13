import { spawn } from "child_process";

const port = process.env.PORT || "5000";

const web = spawn("npx", ["next", "start", "-p", port, "-H", "0.0.0.0"], {
  cwd: "./apps/web",
  stdio: "inherit",
  env: { ...process.env, PORT: port, HOSTNAME: "0.0.0.0" },
});

web.on("exit", (code) => {
  console.log("[web] exited", code);
  process.exit(code ?? 1);
});

process.on("SIGTERM", () => {
  web.kill();
});
