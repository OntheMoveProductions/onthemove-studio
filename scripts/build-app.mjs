// Builds build/app: the folder electron-builder turns into the Mac app.
// It holds the dashboard, the bundled main process + server, and only the
// packages needed at runtime (installed for the target CPU).
//   node scripts/build-app.mjs [--arch arm64|x64] [--platform darwin|win32] [--no-install]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "build", "app");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const arch = arg("--arch", process.arch);
// darwin for the Mac app; the host platform for a local test build.
const platform = arg("--platform", "darwin");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const RUNTIME = ["express", "express-session", "multer", "sharp", "ffmpeg-static", "isomorphic-git"];

// --no-install keeps the already-installed packages; everything else is rebuilt.
const keepModules = process.argv.includes("--no-install");
for (const entry of fs.existsSync(out) ? fs.readdirSync(out) : []) {
  if (keepModules && (entry === "node_modules" || entry === "package-lock.json")) continue;
  fs.rmSync(path.join(out, entry), { recursive: true, force: true });
}
fs.mkdirSync(out, { recursive: true });

console.log("Building dashboard…");
execFileSync(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--logLevel", "warn"], { cwd: root, stdio: "inherit" });
fs.cpSync(path.join(root, "dist"), path.join(out, "dist"), { recursive: true });

console.log("Bundling main process and server…");
await build({
  entryPoints: [path.join(root, "electron", "main.ts")],
  outdir: path.join(out, "build"),
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  external: ["electron"],
  outExtension: { ".js": ".mjs" },
  logLevel: "warning",
});

fs.writeFileSync(
  path.join(out, "package.json"),
  JSON.stringify(
    {
      name: "onthemove-studio",
      productName: "On the Move Studio",
      version: pkg.version,
      private: true,
      type: "module",
      main: "build/main.mjs",
      dependencies: Object.fromEntries(RUNTIME.map((d) => [d, pkg.dependencies[d]])),
      allowScripts: { "ffmpeg-static": true },
    },
    null,
    2,
  ),
);

if (!process.argv.includes("--no-install")) {
  console.log(`Installing runtime packages for ${platform}-${arch}…`);
  // ffmpeg-static downloads its binary for npm_config_arch/platform; sharp
  // picks its prebuilt package from --cpu/--os.
  execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", `--cpu=${arch}`, `--os=${platform}`, "--ignore-scripts=false"], {
    cwd: out,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, npm_config_arch: arch, npm_config_platform: platform },
  });
}
console.log(`Ready: ${out}`);
