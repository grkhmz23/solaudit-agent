import { spawn, execSync } from "child_process";
import net from "net";

const port = parseInt(process.env.PORT || "5000", 10);

function killPort(p) {
  try {
    execSync(`fuser -k ${p}/tcp 2>/dev/null`, { stdio: "ignore" });
  } catch {
    try {
      const result = execSync(
        `grep -r "0\\.0\\.0\\.0:${p.toString(16).toUpperCase().padStart(4, "0")}\\|00000000:${p.toString(16).toUpperCase().padStart(4, "0")}" /proc/net/tcp 2>/dev/null || true`,
        { encoding: "utf8" }
      );
    } catch {}
  }
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
    console.log(`[start] port ${port} is in use, attempting to free it...`);
    killPort(port);
    await new Promise((r) => setTimeout(r, 2000));
    const stillInUse = await checkPort(port);
    if (stillInUse) {
      console.error(`[start] ERROR: port ${port} is still in use. Please stop the other process first.`);
      console.error(`[start] Try: pkill -f "next" or stop the running workflow`);
      process.exit(1);
    }
  }

  const web = spawn("npx", ["next", "start", "-p", String(port), "-H", "0.0.0.0"], {
    cwd: "./apps/web",
    stdio: "inherit",
    env: { ...process.env, PORT: String(port), HOSTNAME: "0.0.0.0" },
  });

  web.on("exit", (code) => {
    console.log("[web] exited", code);
    process.exit(code ?? 1);
  });

  process.on("SIGTERM", () => {
    web.kill();
  });
}

main();
