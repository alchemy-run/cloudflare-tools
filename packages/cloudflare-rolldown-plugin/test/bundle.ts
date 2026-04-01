import { rolldown } from "rolldown";
import cloudflarePlugin from "../src/plugin";

const FIXTURE_NAME = "wasm-init";

const bundle = await rolldown({
  input: `test/fixtures/${FIXTURE_NAME}.ts`,
  plugins: [cloudflarePlugin({})],
});

await bundle.write({
  file: `dist/${FIXTURE_NAME}/index.js`,
  sourcemap: true,
  format: "esm",
});
