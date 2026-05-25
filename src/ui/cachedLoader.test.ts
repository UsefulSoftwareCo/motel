import { describe, expect, it } from "bun:test"
import { makeCachedLoader } from "./cachedLoader.ts"

describe("makeCachedLoader", () => {
	it("ensures cached values without loading twice", async () => {
		let loads = 0
		const loader = makeCachedLoader<string, number>({ load: async () => ++loads })

		expect(await loader.ensure("key")).toBe(1)
		expect(await loader.ensure("key")).toBe(1)
		expect(loads).toBe(1)
	})

	it("refreshes stale values while publishing the updated cache", async () => {
		let value = 1
		const loader = makeCachedLoader<string, number>({ load: async () => value })

		expect(await loader.ensure("key")).toBe(1)
		value = 2
		expect(await loader.refresh("key")).toBe(2)
		expect(loader.get("key")).toBe(2)
	})
})
