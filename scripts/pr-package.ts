import assert from "node:assert";
import path from "node:path";

interface PackageJson {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const packages = [
  "cloudflare-rolldown-plugin",
  "cloudflare-runtime",
  "cloudflare-vite-plugin",
] as const;
type Package = (typeof packages)[number];

const SHORT_SHA = process.argv[2];

assert(SHORT_SHA, "SHORT_SHA is required as first argument");

const cwd = process.cwd();
const pkg = Bun.file(path.join(cwd, "package.json"));
let changed = false;

console.log(`Checking for changes in ${cwd}`);

const json = (await pkg.json()) as PackageJson;

async function replaceDependency(obj: Record<string, string>, name: Package) {
  const key = `@distilled.cloud/${name}`;
  const url = `https://pkg.distilled.cloud/${name}/${SHORT_SHA}`;
  if (!(key in obj)) {
    return;
  }
  obj[key] = url;
  changed = true;
}

for (const key of ["dependencies", "peerDependencies"] as const) {
  if (!json[key]) continue;
  await Promise.all(packages.map((pkg) => replaceDependency(json[key]!, pkg)));
}

if (!changed) {
  console.log("No dependencies changed");
  process.exit(0);
}

await pkg.write(JSON.stringify(json, null, 2) + "\n");
console.log("Updated package.json");
