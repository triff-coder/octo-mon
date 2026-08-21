/** Workers KV requires a minimum TTL of 60 seconds. */
const MIN_KV_TTL_SECONDS = 60;

export async function getJson<T>(kv: KVNamespace, key: string): Promise<T | null> {
  return kv.get<T>(key, "json");
}

export interface PutJsonOptions {
  /** Seconds until the entry expires. Clamped to KV's 60s minimum. */
  expirationTtl?: number;
}

export async function putJson<T>(
  kv: KVNamespace,
  key: string,
  value: T,
  options?: PutJsonOptions,
): Promise<void> {
  const expirationTtl =
    options?.expirationTtl === undefined
      ? undefined
      : Math.max(MIN_KV_TTL_SECONDS, Math.ceil(options.expirationTtl));
  await kv.put(key, JSON.stringify(value), { expirationTtl });
}
