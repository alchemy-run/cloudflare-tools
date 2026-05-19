import mysql2 from "mysql2/promise";

interface Env {
  DATABASE_URL: string;
}

export default {
  async fetch(_request: Request, env: Env) {
    const db = await mysql2.createConnection(env.DATABASE_URL);
    const result = await db.execute("SELECT 1");
    return Response.json(result);
  },
};
