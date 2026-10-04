// `npm start`: the editor in a browser tab (the Mac app uses startServer directly).
import { ADMIN_PASSWORD, HOST, PORT, SITE_ROOT } from "./config.ts";
import { startServer } from "./app.ts";

try {
  await startServer({ port: PORT, host: HOST });
  const url = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;
  console.log(`\n  On the Move Studio is running at ${url}\n  Editing: ${SITE_ROOT}\n`);
  if (!ADMIN_PASSWORD && HOST !== "127.0.0.1" && HOST !== "localhost") {
    console.warn("  Warning: no ADMIN_PASSWORD is set but the editor is reachable from other machines.\n");
  }
} catch (err: any) {
  if (err?.code === "EADDRINUSE") {
    // Otherwise the browser silently keeps using the old (possibly outdated) copy.
    console.error(
      `\n  The editor is already running in another window (port ${PORT} is taken).\n` +
        `  Close that window first, or restart the computer, then open Start Editor again.\n`,
    );
  } else {
    console.error("\nThe editor couldn't start:\n  " + (err?.message ?? err) + "\n");
  }
  process.exit(1);
}
