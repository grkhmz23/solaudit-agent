import { spawn, execSync } from "child_process";
import fs from "fs";
import net from "net";

const port = parseInt(process.env.PORT || "5000", 10);
const portHex = port.toString(16).toUpperCase().padStart(4, "0");

function findPidsOnPort(p) {
  const hex = p.toString(16).toUpperCase().padStart(4, "0");
  const pids = new Set();
  try {
    const tcp = fs.readFileSync("/proc/net/tcp", "utf8");
    const tcp6 = fs.readFileSync("/proc/net/tcp6", "utf8").catch?.(() => "") || "";
    const lines = (tcp + "\n" + tcp6).split("\n");
    const inodes = new Set();
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;
      const localAddr = parts[1];
      const localPort = localAddr.split(":")[1];
      if (localPort === hex) {
        inodes.add(parts[9]);
      }
    }
    if (inodes.size === 0) return [];
    const procDirs = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d));
    for (const pid of procDirs) {
      try {
        const fdDir = `/proc/${pid}/fd`;
        const fds = fs.readdirSync(fdDir);
        for (const fd of fds) {
          try {
            const link = fs.readlinkSync(`${fdDir}/${fd}`);
            if (link.startsWith("socket:[")) {
              const inode = link.slice(8, -1);
              if (inodes.has(inode)) {
                pids.add(parseInt(pid, 10));
              }
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}
  return [...pids];
}

function killPort(p) {
  try {
    execSync(`pkill -9 -f "next start" 2>/dev/null; pkill -9 -f "next dev" 2>/dev/null`, { stdio: "ignore" });
  } catch {}
  const pids = findPidsOnPort(p);
  for (const pid of pids) {
    if (pid === process.pid) continue;
    try { process.kill(pid, 9); } catch {}
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
  let inUse = await checkPort(port);
  if (inUse) {
    console.log(`[start] port ${port} is in use, clearing...`);
    killPort(port);
    await new Promise((r) => setTimeout(r, 3000));
    inUse = await checkPort(port);
    if (inUse) {
      console.error(`[start] ERROR: port ${port} still in use after cleanup. Retrying...`);
      killPort(port);
      await new Promise((r) => setTimeout(r, 3000));
      inUse = await checkPort(port);
      if (inUse) {
        console.error(`[start] FATAL: Cannot free port ${port}. Exiting.`);
        process.exit(1);
      }
    }
    console.log(`[start] port ${port} is now free`);
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
  web.on("exit", (code) => {
    console.log("[web] exited", code);
    process.exit(code ?? 1);
  });

  process.on("SIGTERM", () => {
    web.kill();
    worker.kill();
  });
}

main();
