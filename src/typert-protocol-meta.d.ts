/** Source-analysis facade for the DeepSeek Harness rc.8 Typert generator. */
declare module '@deepseek-ai/dsh-typert-protocol' {
  import { Service, type Context } from '@deepseek-ai/cordis'

  declare const LOOKUP_HOST: unique symbol
  declare const LOOKUP_WIRE: unique symbol
  declare const CONTEXT_WIRE: unique symbol

  export interface TypertLookup<Host, Wire> {
    readonly [LOOKUP_HOST]: Host
    readonly [LOOKUP_WIRE]: Wire
  }

  export interface TypertContext<Wire> {
    readonly [CONTEXT_WIRE]: Wire
  }

  export interface TypertLookupMap {}
  export interface TypertContextMap {}

  export interface TypertGatewayBinding<ServiceType extends object = object> {
    readonly service: ServiceType
    readonly serviceKey: string
    readonly namespace: string
  }

  export abstract class TypertRemoteService<out T = never> extends Service<T> {
    readonly typertRemote: TypertGatewayBinding<this>
    protected constructor(ctx: Context, serviceKey: string)
  }

  type RemoteMethodDecorator = <This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ) => void

  export function Remote<This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void
  export function Remote(exportName: string): RemoteMethodDecorator
}
