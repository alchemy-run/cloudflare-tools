interface HyperdriveAdapter {
  hyperdriveInfo: () => Promise<{
    connectionString: string;
    database: string;
    user: string;
    password: string;
    host: string;
    port: number;
  }>;
  hyperdriveConnect: () => Promise<{
    readable: ReadableStream;
    writable: WritableStream;
    secureTransport: boolean;
    close: () => void;
  }>;
}

export default {
  fetch: async (req: Request, env: { HYPERDRIVE: HyperdriveAdapter }) => {
    const conn = await env.HYPERDRIVE.hyperdriveConnect();
    console.log({
      readable: conn.readable,
      writable: conn.writable,
      secureTransport: conn.secureTransport,
      close: conn.close,
    });
    return Response.json({ success: true, data: conn });
  },
};
