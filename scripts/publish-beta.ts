import { $ } from "bun";
import assert from "node:assert";

const packageName = {
  o: "cloudflare-rolldown-plugin",
  r: "cloudflare-runtime",
  v: "cloudflare-vite-plugin",
}[process.argv[2]];

assert(
  packageName === "cloudflare-rolldown-plugin" ||
    packageName === "cloudflare-runtime" ||
    packageName === "cloudflare-vite-plugin",
  `"${packageName}" is not a valid package name`,
);

const cwd = $.cwd(`packages/${packageName}`);
const version = await cwd`bun pm version prerelease`.text().then((text) => text.trim().slice(1));
console.log(`Publishing ${packageName}@${version}...`);
await cwd`bun i && bun run build`;
await cwd`bun pm pack`;
const tarball = `distilled.cloud-${packageName}-${version}.tgz`;
console.log(
  `cd packages/${packageName} && npm publish ${tarball} --access public --tag beta && cd ../..`,
);
