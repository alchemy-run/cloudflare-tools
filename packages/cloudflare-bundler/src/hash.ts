import * as crypto from "node:crypto";

export const hash = (data: crypto.BinaryLike) => {
  return crypto.createHash("sha1").update(data).digest("hex");
};
