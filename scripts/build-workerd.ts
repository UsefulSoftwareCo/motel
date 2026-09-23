import { build } from "esbuild"
import { mkdir, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
const root = fileURLToPath(new URL("../", import.meta.url))
const docs = {
	debug: await readFile(`${root}skills/motel-debug/SKILL.md`, "utf8"),
	effect: await readFile(`${root}skills/motel-debug/references/effect.md`, "utf8"),
}
await mkdir(`${root}.local/workerd-data`, { recursive: true })
await build({
	absWorkingDir: root,
	entryPoints: ["src/workerd.ts"],
	outfile: "dist/workerd/motel.mjs",
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2022",
	conditions: ["workerd"],
	external: ["node:*", "cloudflare:*"],
	minify: true,
	sourcemap: "external",
	sourcesContent: false,
	legalComments: "external",
	plugins: [
		{
			name: "motel-documents",
			setup(builder) {
				builder.onResolve({ filter: /^motel:documents$/ }, () => ({ path: "documents", namespace: "motel" }))
				builder.onLoad({ filter: /.*/, namespace: "motel" }, () => ({ contents: `export default ${JSON.stringify(docs)}`, loader: "js" }))
			},
		},
	],
})
