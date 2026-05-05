interface Env {
  HYPERDRIVE: Hyperdrive;
}

export default {
  fetch: async (req: Request, env: Env) => {
    console.log({
      connectionString: env.HYPERDRIVE.connectionString,
      database: env.HYPERDRIVE.database,
      user: env.HYPERDRIVE.user,
      password: env.HYPERDRIVE.password,
      host: env.HYPERDRIVE.host,
      port: env.HYPERDRIVE.port,
    });
    return Response.json({ success: true });
  },
};
