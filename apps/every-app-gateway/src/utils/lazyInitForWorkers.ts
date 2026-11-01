/**
 * Wraps a factory function in a Proxy to defer initialization until first access.
 * This prevents async operations (Like creating Tanstack DB Collections) from running in Cloudflare Workers' global scope.
 *
 * @param factory - A function that creates and returns the resource.
 *                  Must be a callback to defer execution; passing the value directly
 *                  would evaluate it at module load time, triggering the Cloudflare error.
 * @returns A Proxy that lazily initializes the resource on first property access
 *
 * @example
 * ```ts
 * export const myCollection = lazyInitForWorkers(() =>
 *   createCollection(queryCollectionOptions({
 *     queryKey: ["myData"],
 *     queryFn: async () => fetchData(),
 *     // ... other options
 *   }))
 * );
 * ```
 */
export function lazyInitForWorkers<T extends object>(factory: () => T): T {
  // Closure: This variable is captured by getInstance() and the Proxy traps below.
  // It remains in memory as long as the returned Proxy is referenced, enabling singleton behavior.
  let instance: T | null = null;

  function getInstance() {
    if (!instance) {
      instance = factory();
    }
    return instance;
  }

  return new Proxy({} as T, {
    get(_, prop) {
      const inst = getInstance();
      const value = inst[prop as keyof T];
      // Bind methods to the instance to preserve `this` context
      return typeof value === "function" ? value.bind(inst) : value;
    },
    set(_, prop, value) {
      const inst = getInstance();
      (inst as any)[prop] = value;
      return true;
    },
    deleteProperty(_, prop) {
      const inst = getInstance();
      delete (inst as any)[prop];
      return true;
    },
    has(_, prop) {
      const inst = getInstance();
      return prop in inst;
    },
    ownKeys(_) {
      const inst = getInstance();
      return Reflect.ownKeys(inst);
    },
    getOwnPropertyDescriptor(_, prop) {
      const inst = getInstance();
      return Reflect.getOwnPropertyDescriptor(inst, prop);
    },
    getPrototypeOf(_) {
      const inst = getInstance();
      return Reflect.getPrototypeOf(inst);
    },
  });
}
