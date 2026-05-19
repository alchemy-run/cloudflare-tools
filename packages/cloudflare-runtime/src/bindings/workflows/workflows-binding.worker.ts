// Engine + WorkflowBinding entrypoints for the workflows engine service.
// These are the Durable Object class and RPC entrypoint defined by the
// vendored `@cloudflare/workflows-shared` source; the cloudflare-rolldown
// bundler picks them up and wires them into the workerd service module.
export {
  WorkflowBinding,
  Engine,
} from "@distilled.cloud/vendor-workflows-shared/workers/workflows-shared/src/local-binding-worker";
