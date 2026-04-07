import { $ } from "bun";
import assert from "node:assert";
import path from "node:path";

assert(
  process.env.NPM_CONFIG_USERCONFIG,
  "npm auth is not configured — is setup-node missing registry-url?",
);
assert(process.env.GITHUB_TOKEN, "GITHUB_TOKEN is not set");

const { packageName, type } = parseArgs();
const packageDirectory = `packages/${packageName}`;
const version = await updatePackageVersion();

const previousTag = await getPreviousTag();
const newTag = `${packageName}@${version}`;

await $`git add ${packageDirectory}/package.json`;
await $`git commit -m "chore(release): ${packageName} v${version}"`;
await $`git tag -a ${newTag} -m ${newTag}`;
await $`git push --follow-tags`;

await $.cwd(packageDirectory)`npm publish --provenance --access public`;

await $`bunx changelogithub --from ${previousTag} --to ${newTag}`;

function parseArgs() {
  const packageName = process.argv[2];
  const type = process.argv[3];
  assert(
    packageName === "cloudflare-rolldown-plugin" || packageName === "cloudflare-bundler",
    `"${packageName}" is not a valid package name`,
  );
  assert(
    type === "patch" || type === "minor" || type === "major",
    `"${type}" is not a valid release type`,
  );
  return { packageName, type };
}

async function updatePackageVersion() {
  const pkg = Bun.file(path.resolve(packageDirectory, "package.json"));
  const json = (await pkg.json()) as { version: string };
  let [major, minor, patch] = json.version.split(".").map(Number);
  switch (type) {
    case "major":
      major++;
      minor = 0;
      patch = 0;
      break;
    case "minor":
      minor++;
      patch = 0;
      break;
    case "patch":
      patch++;
      break;
  }
  const version = `${major}.${minor}.${patch}` as const;
  json.version = version;
  await pkg.write(JSON.stringify(json, null, 2) + "\n");
  return version;
}

async function getPreviousTag() {
  const text = await $`git tag --list --sort=version:refname`.text();
  const tags = text
    .split("\n")
    .filter(Boolean)
    .filter((tag) => tag.startsWith(packageName));
  return tags[tags.length - 1];
}
