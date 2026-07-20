import { json } from "@sveltejs/kit";
import { stringifySetCookie } from "cookie";
import { randomUUID } from "node:crypto";
import { v4 as uuidv4 } from "uuid";

export const GET = ({ platform }) => {
  return json({
    // `uuid` has browser/node conditional exports — the workerd re-bundle must
    // pick an entry that works under workerd (the node entry uses node:crypto,
    // which also works under nodejs_compat; either resolution must not crash).
    uuid: uuidv4(),
    // direct node builtin usage — exercises nodejs_compat externalization
    nodeUuid: randomUUID(),
    // `cookie` — plain conditional-exports dependency
    cookie: stringifySetCookie({ name: "spike", value: "ok" }),
    secret: platform?.env?.SPIKE_SECRET ?? "no-platform-env",
  });
};
