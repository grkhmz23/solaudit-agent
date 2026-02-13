import { spawn, execSync } from "child_process";
import net from "net";

const port = parseInt(process.env.PORT || "5000", 10);

function killPort(p) {
  try { execSync("fuser -k " + p + "/tcp 2>/dev/null", { stdio: "ignore" }); } catch {}
}

function checkPort(p) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once("error", () => resolve(true))
      .once("listening", () => { tester.close(); resolve(false); })
      .listen(p, "0.0.0.0");
  });
}

async function main() {
  const inUse = await checkPort(port);
  if (inUse) {
    console.log("[start] port " + port + " in use, freeing...");
    killPort(port);
    await new Promise((r) => setTimeout(r, 2000));
  }

  const worker = spawn("node", ["apps/worker/dist/index.js"], {
    stdio: "inherit",
    env: { ...process.env },
  });
  worker.on("exit", (code) => console.log("[worker] exited", code));

  const web = spawn("npx", ["next", "start", "-p", String(port), "-H", "0.0.0.0"], {
    cwd: "./apps/web",
    stdio: "inherit",
    env: { ...process.env, PORT: String(port), HOSTNAME: "0.0.0.0" },
  });
  web.on("exit", (code) => { console.log("[web] exited", code); process.exit(code ?? 1); });

  process.on("SIGTERM", () => { web.kill(); worker.kill(); });
}

main();
