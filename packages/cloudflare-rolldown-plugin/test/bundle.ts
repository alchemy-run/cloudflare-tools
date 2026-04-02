import { rolldown } from "rolldown";
import cloudflare from "../src/plugin";
import { createMiniflare } from "./utils/miniflare";

const FIXTURE_NAME = "hello-world";

const bundle = await rolldown({
  input: `test/fixtures/${FIXTURE_NAME}.ts`,
  plugins: [cloudflare()],
});

const result = await bundle.generate({
  file: `dist/${FIXTURE_NAME}/index.js`,
  sourcemap: true,
  format: "esm",
});
await using mf = await createMiniflare(result, { compatibilityDate: "2026-04-01" });
const response = await mf.dispatchFetch("http://localhost");
console.log(await response.text());
