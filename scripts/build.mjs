// Bundles the Lambda functions and the ECS agent server with esbuild.
//   node scripts/build.mjs lambdas   -> build/lambda/<name>/index.mjs
//   node scripts/build.mjs agent     -> build/agent/main.mjs
import { build } from "esbuild";
import { rmSync } from "node:fs";

const LAMBDAS = ["mcp", "webhook", "worker", "indexer", "heartbeat", "presignup"];
const target = process.argv[2] ?? "all";

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  minify: false,
  logLevel: "warning",
  // Some dependencies still call require(); give the ESM bundle a real one.
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
};

if (target === "lambdas" || target === "all") {
  rmSync("build/lambda", { recursive: true, force: true });
  for (const name of LAMBDAS) {
    await build({ ...common, entryPoints: [`backend/${name}/handler.ts`], outfile: `build/lambda/${name}/index.mjs` });
    console.log(`built build/lambda/${name}/index.mjs`);
  }
}

if (target === "agent" || target === "all") {
  rmSync("build/agent", { recursive: true, force: true });
  await build({ ...common, entryPoints: ["backend/agent-server/main.ts"], outfile: "build/agent/main.mjs" });
  console.log("built build/agent/main.mjs");
}
