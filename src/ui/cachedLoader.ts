// Generic cache with inflight-promise dedup, used by the facet and AI
// call detail caches. Both previously duplicated this pattern by hand:
// a Map for the cached value, a parallel Map for in-flight promises,
// and three small exports (get / ensure / invalidate). This factory is
// the seam; callers only need to supply a loader and (optionally) a
// hash function for compound keys.

export interface CachedLoader<K, V> {
	/** Synchronous cache lookup. Returns `undefined` if the key has never been loaded. */
	readonly get: (key: K) => V | undefined
	/** Resolves with the cached value if present, otherwise loads it (deduplicating concurrent calls for the same key). */
	readonly ensure: (key: K) => Promise<V>
	/** Loads the latest value while deduplicating any load already running for this key. */
	readonly refresh: (key: K) => Promise<V>
	/** Drops every cached value and aborts dedup tracking for in-flight loads. */
	readonly invalidate: () => void
}

export interface CachedLoaderOptions<K, V> {
	readonly load: (key: K) => Promise<V>
	/** Required when `K` is a compound type that can't be used as a Map key directly. */
	readonly hash?: (key: K) => string
}

export const makeCachedLoader = <K, V>(opts: CachedLoaderOptions<K, V>): CachedLoader<K, V> => {
	const hash = opts.hash ?? ((k) => k as unknown as string)
	const cache = new Map<string, V>()
	const inflight = new Map<string, Promise<V>>()

	const get = (key: K) => cache.get(hash(key))

	const refresh = (key: K): Promise<V> => {
		const h = hash(key)
		const existing = inflight.get(h)
		if (existing) return existing
		const request = opts.load(key)
			.then((data) => {
				cache.set(h, data)
				return data
			})
			.finally(() => {
				inflight.delete(h)
			})
		inflight.set(h, request)
		return request
	}

	const ensure = (key: K): Promise<V> => {
		const h = hash(key)
		if (cache.has(h)) return Promise.resolve(cache.get(h) as V)
		return refresh(key)
	}

	const invalidate = () => {
		cache.clear()
		inflight.clear()
	}

	return { get, ensure, refresh, invalidate }
}
