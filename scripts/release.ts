import { $ } from "bun";
import assert from "node:assert";
import path from "node:path";

const PACKAGE_DIRECTORY = "packages/cloudflare-rolldown-plugin";

assert(
  process.env.NPM_CONFIG_USERCONFIG,
  "npm auth is not configured — is setup-node missing registry-url?",
);
assert(process.env.GITHUB_TOKEN, "GITHUB_TOKEN is not set");

const type = parseReleaseType();
const version = await updatePackageVersion();

const previousTag = await getPreviousTag();
const newTag = `cloudflare-rolldown-plugin@${version}`;

await $`git add ${PACKAGE_DIRECTORY}/package.json`;
await $`git commit -m "chore(release): cloudflare-rolldown-plugin v${version}"`;
await $`git tag -a ${newTag} -m ${newTag}`;
await $`git push --follow-tags`;

await $.cwd(PACKAGE_DIRECTORY)`npm publish --provenance --access public`;

await $`bunx changelogithub --from ${previousTag} --to ${newTag}`;

function parseReleaseType() {
  const type = process.argv[2];
  assert(
    type === "patch" || type === "minor" || type === "major",
    `"${type}" is not a valid release type`,
  );
  return type;
}

async function updatePackageVersion() {
  const pkg = Bun.file(path.resolve(PACKAGE_DIRECTORY, "package.json"));
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
  const tags = text.split("\n").filter(Boolean);
  return tags[tags.length - 1];
}
