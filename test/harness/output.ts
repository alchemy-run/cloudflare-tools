import * as path from "node:path";
import type { Output } from "../../src/core/Output.js";

export const outputPath = (output: Output, fileName: string = output.main) =>
  path.resolve(output.directory, fileName);
