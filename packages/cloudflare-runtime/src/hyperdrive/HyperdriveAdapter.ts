export interface HyperdriveAdapter {
  readonly hyperdrive: {
    readonly info: () => Promise<{
      connectionString: string;
      database: string;
      user: string;
      password: string;
      host: string;
      port: number;
    }>;
    readonly connect: () => Promise<{
      readable: ReadableStream;
      writable: WritableStream;
      close: () => void;
    }>;
  };
}
