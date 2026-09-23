import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

type PackResult = {
	readonly filename: string
	readonly files: ReadonlyArray<{ readonly path: string }>
}

const root = path.resolve(import.meta.dir, "..")
const temp = await mkdtemp(path.join(tmpdir(), "motel-release-"))
const packDir = path.join(temp, "pack")
const consumerDir = path.join(temp, "consumer")

const run = async (
	cmd: ReadonlyArray<string>,
	cwd: string,
	options: { readonly stdin?: string; readonly env?: Record<string, string | undefined> } = {},
) => {
	const process = Bun.spawn(cmd, {
		cwd,
		env: options.env,
		stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
		stdout: "pipe",
		stderr: "pipe",
	})
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	])
	if (exitCode !== 0) {
		throw new Error(`${cmd.join(" ")} failed (${exitCode})\n${stdout}${stderr}`)
	}
	return stdout
}

const smokeMcp = async (executable: string, cwd: string) => {
	const process = Bun.spawn([executable], {
		cwd,
		stdin: "pipe",
		stdout: "ignore",
		stderr: "pipe",
	})
	const exited = process.exited.then((exitCode) => ({ exitCode }))
	const result = await Promise.race([exited, Bun.sleep(500).then(() => null)])
	if (result) {
		const stderr = await new Response(process.stderr).text()
		throw new Error(`Packed motel-mcp exited during startup (${result.exitCode})\n${stderr}`)
	}
	process.kill()
	await process.exited
}

try {
	await mkdir(packDir)
	await mkdir(consumerDir)
	await run(["bun", "run", "web:build"], root)

	const packOutput = await run(
		["npm", "pack", "--json", "--pack-destination", packDir],
		root,
	)
	const [packed] = JSON.parse(packOutput) as PackResult[]
	if (!packed) throw new Error("npm pack did not produce an artifact")

	const included = new Set(packed.files.map((file) => file.path))
	for (const required of [
		"skills/motel-debug/SKILL.md",
		"skills/motel-debug/references/effect.md",
		"src/motel.ts",
		"src/mcp.ts",
		"web/dist/index.html",
	]) {
		if (!included.has(required)) throw new Error(`Packed artifact is missing ${required}`)
	}

	const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
		readonly name: string
		readonly version: string
	}
	const tarball = path.join(packDir, packed.filename)
	await Bun.write(
		path.join(consumerDir, "package.json"),
		JSON.stringify({ private: true, dependencies: { [packageJson.name]: `file:${tarball}` } }, null, 2),
	)
	await run(["bun", "install", "--no-save"], consumerDir)

	const motel = path.join(consumerDir, "node_modules", ".bin", "motel")
	const motelMcp = path.join(consumerDir, "node_modules", ".bin", "motel-mcp")
	const help = await run([motel, "--help"], consumerDir)
	if (!help.includes("motel daemon")) throw new Error("Packed motel binary did not print its help output")
	const runtimeDir = path.join(temp, "runtime")
	await mkdir(runtimeDir)
	const runtimeEnv = {
		...process.env,
		MOTEL_RUNTIME_DIR: runtimeDir,
		MOTEL_OTEL_DB_PATH: path.join(runtimeDir, "telemetry.sqlite"),
	}
	const installedRoot = path.join(consumerDir, "node_modules", "@kitlangton", "motel")
	await run([
		"bun",
		"-e",
		`const { Effect } = await import("effect"); const { storeRuntime } = await import(${JSON.stringify(path.join(installedRoot, "src", "runtime.ts"))}); const { TelemetryStore } = await import(${JSON.stringify(path.join(installedRoot, "src", "services", "TelemetryStore.ts"))}); await storeRuntime.runPromise(Effect.flatMap(TelemetryStore, (store) => store.listServices)); await storeRuntime.dispose()`,
	], consumerDir, { env: runtimeEnv })
	try {
		const services = await run([motel, "services"], consumerDir, { env: runtimeEnv })
		if (!services.trim().startsWith("[")) throw new Error("Packed motel binary did not query services")
	} finally {
		await run([motel, "stop"], consumerDir, { env: runtimeEnv }).catch(() => undefined)
	}
	await smokeMcp(motelMcp, consumerDir)

	const reportedVersion = await run(
		["bun", "-e", `import { MOTEL_VERSION } from ${JSON.stringify(path.join(installedRoot, "src", "registry.ts"))}; console.log(MOTEL_VERSION)`],
		consumerDir,
	)
	if (reportedVersion.trim() !== packageJson.version) {
		throw new Error(`Runtime version ${reportedVersion.trim()} does not match package version ${packageJson.version}`)
	}

	console.log(`Validated ${packed.filename} from a clean consumer`)
} finally {
	await rm(temp, { recursive: true, force: true })
}
