// `npm start`: builds the dashboard the first time (or after an update),
// then runs the server. Pass --open to open the browser once it's up.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist", "index.html");
const newest = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce((t, e) => {
    const p = path.join(dir, e.name);
    return Math.max(t, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
  }, 0);

if (!fs.existsSync(dist) || newest(path.join(root, "client")) > fs.statSync(dist).mtimeMs) {
  console.log("Building the dashboard…");
  const r = spawnSync(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--logLevel", "warn"], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const server = spawn(process.execPath, ["--import", "tsx", path.join(root, "server", "index.ts")], { cwd: root, stdio: "inherit" });
let exited = false;
server.on("exit", (code) => {
  exited = true;
  process.exit(code ?? 0);
});

// Open the browser only once this copy of the editor is answering. If
// another copy already holds the port, this one exits and nothing opens,
// so the browser can't end up on an outdated editor.
if (process.argv.includes("--open")) {
  const url = `http://localhost:${process.env.PORT || 4500}`;
  const started = Date.now();
  const poll = async () => {
    if (exited || Date.now() - started > 60_000) return;
    try {
      const res = await fetch(`${url}/api/session`);
      if (res.ok) {
        await new Promise((r) => setTimeout(r, 400));
        if (exited) return;
        const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
        spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true }).unref();
        return;
      }
    } catch {}
    setTimeout(poll, 300);
  };
  setTimeout(poll, 300);
}
