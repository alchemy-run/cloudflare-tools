import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { buildLocalService, makeRemoteService } from "./Client.ts";
import { hostLayers } from "./Host.ts";
import { readAddressFromEnv, type HoistedLayerAddress } from "./Protocol.ts";

export type AnyService = Context.Service<any, any>;
export type ServiceOf<Tag extends AnyService> = Tag["Service"];
export type IdentifierOf<Tag extends AnyService> = Tag["Identifier"];

export interface MethodDescriptor {
  readonly payload?: Schema.Top;
  readonly success?: Schema.Top;
  readonly error?: Schema.Top;
}

export interface StreamDescriptor {
  readonly payload?: Schema.Top;
  readonly item?: Schema.Top;
  readonly error?: Schema.Top;
}

export interface ServiceDescriptor {
  readonly methods?: Record<string, MethodDescriptor>;
  readonly streams?: Record<string, StreamDescriptor>;
}

type PayloadOf<Descriptor> = Descriptor extends { readonly payload: infer Payload extends Schema.Top }
  ? Payload["Type"]
  : void;

type SuccessOf<Descriptor> = Descriptor extends { readonly success: infer Success extends Schema.Top }
  ? Success["Type"]
  : void;

type ItemOf<Descriptor> = Descriptor extends { readonly item: infer Item extends Schema.Top } ? Item["Type"] : void;

type ErrorOf<Descriptor> = Descriptor extends { readonly error: infer Error extends Schema.Top }
  ? Error["Type"]
  : never;

type MethodsShape<Methods> = Methods extends Record<string, MethodDescriptor>
  ? {
      readonly [Key in keyof Methods]: (
        payload: PayloadOf<Methods[Key]>,
      ) => Effect.Effect<SuccessOf<Methods[Key]>, ErrorOf<Methods[Key]>>;
    }
  : {};

type StreamsShape<Streams> = Streams extends Record<string, StreamDescriptor>
  ? {
      readonly [Key in keyof Streams]: (
        payload: PayloadOf<Streams[Key]>,
      ) => Stream.Stream<ItemOf<Streams[Key]>, ErrorOf<Streams[Key]>>;
    }
  : {};

export type ServiceShape<Descriptor extends ServiceDescriptor> = MethodsShape<Descriptor["methods"]> &
  StreamsShape<Descriptor["streams"]>;

export interface HoistedDefinition<Tag extends AnyService, Rpcs extends Rpc.Any = Rpc.Any> {
  readonly tag: Tag;
  readonly group: RpcGroup.RpcGroup<Rpcs>;
  readonly fromClient: (client: any) => ServiceOf<Tag>;
  readonly toHandlers: (service: ServiceOf<Tag>) => RpcGroup.HandlersFrom<Rpcs>;
}

export interface HostedServer {
  readonly address: HoistedLayerAddress;
  readonly env: Record<string, string>;
}

export type HoistedEntry<
  Tag extends AnyService,
  Rpcs extends Rpc.Any = Rpc.Any,
  E = never,
  R = never,
> = readonly [HoistedDefinition<Tag, Rpcs>, Layer.Layer<IdentifierOf<Tag>, E, R>];

export interface HoistedOptions<Tag extends AnyService, E = never, R = never> {
  readonly fallback: Layer.Layer<IdentifierOf<Tag>, E, R>;
  readonly address?: HoistedLayerAddress | undefined;
}

type ServiceExtras<Tag extends AnyService, Rpcs extends Rpc.Any> = {
  readonly definition: HoistedDefinition<Tag, Rpcs>;
  readonly group: RpcGroup.RpcGroup<Rpcs>;
  readonly hoisted: <E = never, R = never>(
    options: HoistedOptions<Tag, E, R>,
  ) => Layer.Layer<IdentifierOf<Tag>, E, R>;
  readonly host: <E = never, R = never>(
    layer: Layer.Layer<IdentifierOf<Tag>, E, R>,
    options?: Partial<HoistedLayerAddress>,
  ) => Effect.Effect<HostedServer, never, any>;
};

type HoistedService<Descriptor extends ServiceDescriptor> = AnyService &
  ServiceExtras<AnyService, Rpc.Any> & {
    readonly implement: <E = never, R = never>(
      build: ServiceShape<Descriptor> | Effect.Effect<ServiceShape<Descriptor>, E, R>,
    ) => Layer.Layer<any, E, any>;
  };

function resolveDefinition(definition: HoistedDefinition<any, any> | { readonly definition: HoistedDefinition<any, any> }) {
  return "definition" in definition ? definition.definition : definition;
}

export function define<Tag extends AnyService, Rpcs extends Rpc.Any>(definition: HoistedDefinition<Tag, Rpcs>) {
  return Object.assign(definition, {
    hoisted<E = never, R = never>(options: HoistedOptions<Tag, E, R>) {
      return hoisted(definition, options);
    },
    host<E = never, R = never>(
      layer: Layer.Layer<IdentifierOf<Tag>, E, R>,
      options?: Partial<HoistedLayerAddress>,
    ) {
      return host([[definition, layer]], options);
    },
  });
}

export function hoisted<Tag extends AnyService, E = never, R = never>(
  definitionLike: HoistedDefinition<Tag, any> | { readonly definition: HoistedDefinition<Tag, any> },
  options: HoistedOptions<Tag, E, R>,
) {
  const definition = resolveDefinition(definitionLike);
  return Layer.effect(
    definition.tag,
    Effect.gen(function* () {
      const address = options.address ?? readAddressFromEnv();
      if (address !== undefined) {
        return yield* makeRemoteService(definition, address);
      }
      return yield* buildLocalService(definition.tag, options.fallback);
    }),
  );
}

export function host(
  entries: ReadonlyArray<
    readonly [
      HoistedDefinition<any, any> | { readonly definition: HoistedDefinition<any, any> },
      Layer.Layer<any, any, any>,
    ]
  >,
  options?: Partial<HoistedLayerAddress>,
) {
  return hostLayers(
    entries.map(([definition, layer]) => [resolveDefinition(definition), layer] as const),
    options,
  );
}

export function service<const Descriptor extends ServiceDescriptor>(
  name: string,
  descriptor: Descriptor,
): HoistedService<Descriptor> {
  const tag = Context.Service<ServiceShape<Descriptor>>(name);

  const methodEntries = Object.entries(descriptor.methods ?? {});
  const streamEntries = Object.entries(descriptor.streams ?? {});
  const rpcs = [
    ...methodEntries.map(([key, value]) =>
      Rpc.make(`${name}/${key}`, {
        payload: value.payload ?? Schema.Void,
        success: value.success ?? Schema.Void,
        error: value.error ?? Schema.Never,
      }),
    ),
    ...streamEntries.map(([key, value]) =>
      Rpc.make(`${name}/${key}`, {
        payload: value.payload ?? Schema.Void,
        success: value.item ?? Schema.Void,
        error: value.error ?? Schema.Never,
        stream: true,
      }),
    ),
  ];

  if (rpcs.length === 0) {
    throw new Error(`HoistedLayer.service("${name}") requires at least one method or stream`);
  }

  const group = RpcGroup.make(rpcs[0], ...rpcs.slice(1));
  const definition = define({
    tag,
    group,
    fromClient(client) {
      const remoteClient = client as (tag: string, payload: unknown, options?: unknown) => unknown;
      const service: Record<string, unknown> = {};
      for (const [key] of methodEntries) {
        const rpcTag = `${name}/${key}`;
        service[key] = (payload: unknown) => Effect.orDie(remoteClient(rpcTag, payload) as Effect.Effect<unknown>);
      }
      for (const [key] of streamEntries) {
        const rpcTag = `${name}/${key}`;
        service[key] = (payload: unknown) => Stream.orDie(remoteClient(rpcTag, payload) as Stream.Stream<unknown>);
      }
      return tag.of(service as ServiceShape<Descriptor>);
    },
    toHandlers(service) {
      const handlers: Record<string, unknown> = {};
      for (const [key] of methodEntries) {
        handlers[`${name}/${key}`] = service[key as keyof ServiceShape<Descriptor>];
      }
      for (const [key] of streamEntries) {
        handlers[`${name}/${key}`] = service[key as keyof ServiceShape<Descriptor>];
      }
      return group.of(handlers as RpcGroup.HandlersFrom<any>);
    },
  });

  return Object.assign(tag, {
    definition,
    group,
    implement<E = never, R = never>(
      build: ServiceShape<Descriptor> | Effect.Effect<ServiceShape<Descriptor>, E, R>,
    ) {
      return Effect.isEffect(build)
        ? Layer.effect(tag, Effect.map(build, tag.of))
        : Layer.succeed(tag, tag.of(build));
    },
    hoisted<E = never, R = never>(options: HoistedOptions<typeof tag, E, R>) {
      return hoisted(definition, options);
    },
    host<E = never, R = never>(
      layer: Layer.Layer<IdentifierOf<typeof tag>, E, R>,
      options?: Partial<HoistedLayerAddress>,
    ) {
      return host([[definition, layer]], options);
    },
  }) as unknown as HoistedService<Descriptor>;
}

export const HoistedLayer = {
  define,
  hoisted,
  host,
  service,
};
