// Realistic-ish @rocicorp/zero worker, modeled on rocicorp/hello-zero-cf.
// Exercises the code paths that transitively bundle @databases/sql,
// @databases/escape-identifier, and @databases/validate-unicode (all CJS).
import {
  createBuilder,
  createSchema,
  defineMutator,
  defineMutators,
  defineQueries,
  defineQuery,
  escapeLike,
  mustGetQuery,
  number,
  relationships,
  string,
  table,
} from "@rocicorp/zero";
import { handleQueryRequest } from "@rocicorp/zero/server";

const user = table("user")
  .columns({
    id: string(),
    name: string(),
  })
  .primaryKey("id");

const message = table("message")
  .columns({
    id: string(),
    senderID: string().from("sender_id"),
    body: string(),
    timestamp: number(),
  })
  .primaryKey("id");

const messageRelationships = relationships(message, ({ one }) => ({
  sender: one({
    sourceField: ["senderID"],
    destField: ["id"],
    destSchema: user,
  }),
}));

const schema = createSchema({
  tables: [user, message],
  relationships: [messageRelationships],
});

const zql = createBuilder(schema);

const queries = defineQueries({
  users: defineQuery(() => zql.user),
  messages: defineQuery(() => zql.message.related("sender").orderBy("timestamp", "desc")),
  searchMessages: defineQuery(({ args }: { args: { body: string } }) =>
    zql.message.where("body", "LIKE", `%${escapeLike(args.body)}%`),
  ),
});

const mutators = defineMutators({
  message: {
    create: defineMutator(async ({ tx, args }) => {
      await tx.mutate.message.insert(
        args as { id: string; senderID: string; body: string; timestamp: number },
      );
    }),
  },
});

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/get-queries") {
      const result = await handleQueryRequest({
        handler: (name, args) => {
          const query = mustGetQuery(queries, name);
          return query.fn({ args, ctx: undefined });
        },
        schema,
        request,
        userID: null,
      });
      return Response.json(result);
    }
    // Sanity check: invoke a builder operation that exercises the SQL pipelines
    // that depend on @databases/sql + @databases/escape-identifier.
    const query = zql.message.where("body", "LIKE", `%${escapeLike("hi")}%`);
    return Response.json({
      ok: true,
      tables: Object.keys(schema.tables),
      queries: Object.keys(queries),
      mutators: Object.keys(mutators.message),
      hasQuery: typeof query === "object",
    });
  },
};
