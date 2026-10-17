import type { getState } from './service';
type Serialized<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Serialized<U>[]
    : T extends object
      ? { [K in keyof T]: Serialized<T[K]> }
      : T;
export type AppState = Serialized<Awaited<ReturnType<typeof getState>>>;
export type RequestItem = AppState['requests'][number];
export type EmailItem = AppState['emails'][number];
