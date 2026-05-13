import { $ } from "bun";

for (const packageName of [
  //   "cloudflare-rolldown-plugin",
  "cloudflare-runtime",
  "cloudflare-vite-plugin",
]) {
  const cwd = $.cwd(`packages/${packageName}`);
  const version = await cwd`bun pm version prerelease`.text().then((text) => text.trim().slice(1));
  console.log(`Publishing ${packageName}@${version}...`);
  await cwd`bun i && bun run build`;
  await cwd`bun pm pack`;
  const tarball = `distilled.cloud-${packageName}-${version}.tgz`;
  //   console.log(`cd packages/${packageName} && npm publish ${tarball} --access public --tag beta`);
  await cwd`npm publish ${tarball} --access public --tag beta`;
  console.log(`Published ${packageName}@${version}`);
}
