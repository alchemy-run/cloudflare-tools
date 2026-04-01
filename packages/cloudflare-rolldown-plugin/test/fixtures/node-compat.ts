import fs from "node:fs";

export default {
  async fetch() {
    return new Response(fs.readFileSync("test/fixtures/node-compat.ts", "utf-8"));
  },
};
