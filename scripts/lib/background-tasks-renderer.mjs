import { build } from "esbuild";
import { fileURLToPath } from "node:url";

export async function buildBackgroundTasksRenderer() {
  const source = fileURLToPath(new URL("../../source/desktop-tasks/panel.js", import.meta.url));
  const result = await build({ entryPoints: [source], write: false, bundle: true, format: "iife", platform: "browser", target: "chrome144" });
  return result.outputFiles[0].text;
}
