export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export const expect = <T extends true>() => {};
export type Row<Q> = Q extends (...args: any[]) => Promise<infer R> ? (R extends (infer E)[] ? E : NonNullable<R>) : never;
export type Result<Q> = Q extends (...args: any[]) => Promise<infer R> ? R : never;
export type Params<Q> = Q extends (db: any, params: infer P) => any ? P : void;
