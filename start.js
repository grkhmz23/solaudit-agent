import { spawn } from "child_process";
import http from "http";

// Instant health check server while Next.js boots
let nextReady = false;
const healthServer = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", ready: nextReady }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
healthServer.listen(3000, () => {
  console.log("[health] ready on :3000");
});

// Boot Next.js on 3001, then swap
const web = spawn("npx", ["next", "start", "-p", "3001"], {
  cwd: "./apps/web",
  stdio: "inherit",
  env: { ...process.env },
});

// Wait for Next.js to be ready, then proxy
setTimeout(() => {
  nextReady = true;
  healthServer.close(() => {
    console.log("[health] handing off to Next.js");
  });
  // Proxy all traffic to Next.js
  const proxy = http.createServer((req, res) => {
    const opts = { hostname: "127.0.0.1", port: 3001, path: req.url, method: req.method, headers: req.headers };
    const p = http.request(opts, (upstream) => {
      res.writeHead(upstream.statusCode || 200, upstream.headers);
      upstream.pipe(res);
    });
    p.on("error", () => { res.writeHead(502); res.end("Bad Gateway"); });
    req.pipe(p);
  });
  proxy.listen(3000, () => console.log("[proxy] forwarding :3000 → :3001"));
}, 8000);

// Boot worker
const worker = spawn("node", ["apps/worker/dist/index.js"], {
  stdio: "inherit",
  env: { ...process.env },
});

web.on("exit", (code) => { console.log("[web] exited", code); process.exit(code ?? 1); });
worker.on("exit", (code) => { console.log("[worker] exited", code); process.exit(code ?? 1); });
process.on("SIGTERM", () => { web.kill(); worker.kill(); });
