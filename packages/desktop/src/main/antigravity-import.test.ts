import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { importExistingOpenCode } from "./antigravity-import"
import { configureAntigravity } from "./antigravity-config"

async function fixture() {
  const root = await mkdtemp(path.resolve("../../tmp/import-test-"))
  const source = path.join(root, "home", ".config", "opencode")
  const target = path.join(root, "private", "config", "opencode")
  const cli = path.join(root, "bin")
  await Promise.all([source, target, cli].map((directory) => mkdir(directory, { recursive: true })))
  return { root, source, target, cli, options: { home: path.join(root, "home"), path: cli, desktop: ["OpenCode"] } }
}

test("detects CLI/desktop and imports JSONC, agents and skills without sharing credentials or service state", async () => {
  const data = await fixture()
  await writeFile(path.join(data.cli, "opencode.cmd"), "fixture")
  await writeFile(path.join(data.source, "opencode.jsonc"), `{
    // V1 config remains accepted by the bundled V2 backend.
    "model": "google/old-default",
    "autoupdate": true,
    "mcp": {"fixture": {"type":"remote", "url":"https://example.test/mcp", "enabled":false}},
    "command": {"probe": {"template":"fixture command"}},
    "plugin": ["opencode-antigravity-auth@1", ["./plugins/local", {"fixture":true}]],
    "instructions": ["{file:instructions.txt}"],
    "permission": {"edit":"ask"},
  }`)
  await mkdir(path.join(data.source, "plugins", "local"), { recursive: true })
  await mkdir(path.join(data.source, "skills", "probe"), { recursive: true })
  await mkdir(path.join(data.source, "agents"), { recursive: true })
  await writeFile(path.join(data.source, "skills", "probe", "SKILL.md"), "---\nname: probe\ndescription: Fixture skill\n---\nFixture body")
  await writeFile(path.join(data.source, "agents", "probe.md"), "Fixture agent")
  await writeFile(path.join(data.source, "AGENTS.md"), "Fixture instruction")
  await writeFile(path.join(data.source, "auth.json"), "secret fixture must stay in official profile")
  await writeFile(path.join(data.source, "service.json"), '{"port":49374}')
  await writeFile(path.join(data.source, "opencode.db"), "fixture db")
  const original = await readFile(path.join(data.source, "opencode.jsonc"), "utf8")
  const current = { model: "antigravity/gemini-3.8-flash-tiered#high", permissions: [], providers: { private: {} } }
  const result = await importExistingOpenCode(data.target, current, data.options)
  expect(result.report?.status).toBe("imported")
  expect(result.report?.installations.cli).toEqual([path.join(data.cli, "opencode.cmd")])
  expect(result.report?.installations.desktop).toEqual(["OpenCode"])
  expect(result.config.model).toBe(current.model)
  expect(result.config.autoupdate).toBeUndefined()
  expect(result.config.command).toEqual({ probe: { template: "fixture command" } })
  expect(JSON.stringify(result.config.mcp)).toContain("https://example.test/mcp")
  const final = configureAntigravity(result.config, path.join(data.root, "resources"), new Uint8Array([1]))
  expect(final.plugins).toHaveLength(2)
  const plugin = final.plugins[0]
  if (typeof plugin === "string") throw new Error("Configured plugin must retain its options")
  expect(fileURLToPath(plugin.package)).toBe(path.join(data.source, "plugins", "local"))
  expect(JSON.stringify(result.config.instructions)).toContain("instructions.txt")
  expect(JSON.stringify(result.config.instructions)).toContain(data.source.replaceAll("\\", "/"))
  expect(await readFile(path.join(data.target, "skills", "probe", "SKILL.md"), "utf8")).toContain("Fixture body")
  expect(await readFile(path.join(data.target, "agents", "probe.md"), "utf8")).toBe("Fixture agent")
  expect(await readFile(path.join(data.source, "opencode.jsonc"), "utf8")).toBe(original)
  expect(await readdir(data.target)).not.toContain("auth.json")
  expect(await readdir(data.target)).not.toContain("service.json")
  expect(await readdir(data.target)).not.toContain("opencode.db")
  expect(JSON.parse(await readFile(path.join(data.target, "opencode.json.before-import"), "utf8"))).toEqual(current)
})

test("completed import runs once and retains private settings and edited skill files", async () => {
  const data = await fixture()
  await writeFile(path.join(data.source, "opencode.json"), '{"username":"official","mcp":{"servers":{"source":{"type":"remote","url":"https://example.test"}}}}')
  await mkdir(path.join(data.source, "skills"))
  await mkdir(path.join(data.target, "skills"))
  await writeFile(path.join(data.source, "skills", "probe.md"), "Official copy")
  await writeFile(path.join(data.target, "skills", "probe.md"), "Private edited copy")
  const current = { username: "private", mcp: { servers: { private: { type: "remote", url: "https://private.test" } } } }
  const first = await importExistingOpenCode(data.target, current, data.options)
  expect(first.config.username).toBe("private")
  expect(Object.keys(first.config.mcp.servers)).toEqual(["source", "private"])
  expect(await readFile(path.join(data.target, "skills", "probe.md"), "utf8")).toBe("Private edited copy")
  await writeFile(path.join(data.source, "opencode.json"), '{"username":"changed"}')
  expect(await importExistingOpenCode(data.target, first.config, data.options)).toEqual({ config: first.config })
})

test("missing or malformed official config does not block the private profile, and later discovery retries", async () => {
  const data = await fixture()
  const current = { model: "antigravity/gemini-3-flash" }
  expect((await importExistingOpenCode(data.target, current, data.options)).report?.status).toBe("not-found")
  await writeFile(path.join(data.source, "opencode.json"), "{ malformed")
  const invalid = await importExistingOpenCode(data.target, current, data.options)
  expect(invalid.config).toEqual(current)
  expect(invalid.report?.status).toBe("partial")
  await writeFile(path.join(data.source, "opencode.json"), '{"username":"found-later"}')
  expect((await importExistingOpenCode(data.target, current, data.options)).config.username).toBe("found-later")
})

test("honors explicit CLI config directory/file and excludes the private profile from discovery", async () => {
  const data = await fixture()
  const custom = path.join(data.root, "custom config")
  await mkdir(custom)
  await writeFile(path.join(data.source, "opencode.json"), '{"username":"other-profile"}')
  await writeFile(path.join(custom, "specific.jsonc"), '{"username":"custom-profile"}')
  const result = await importExistingOpenCode(data.target, {}, { ...data.options, configDirectory: custom, configFile: path.join(custom, "specific.jsonc") })
  expect(result.config.username).toBe("custom-profile")
  expect(result.report?.sources).toEqual([path.join(custom, "specific.jsonc")])
  const fresh = path.join(data.root, "own")
  await mkdir(fresh)
  await writeFile(path.join(fresh, "opencode.json"), '{"username":"own"}')
  expect((await importExistingOpenCode(fresh, {}, { ...data.options, configDirectory: fresh })).report?.status).toBe("not-found")
})

test("preserves absolute Windows file substitutions and environment placeholders without copying their values", async () => {
  const data = await fixture()
  const absolute = path.join(data.source, "instructions.txt")
  await writeFile(path.join(data.source, "opencode.json"), JSON.stringify({
    instructions: [`{file:${absolute}}`, "{file:relative.txt}", "{env:EXAMPLE_TOKEN}"],
  }))
  const result = await importExistingOpenCode(data.target, {}, data.options)
  expect(result.report?.status).toBe("imported")
  expect(result.config.instructions).toEqual([
    `{file:${absolute.replaceAll("\\", "/")}}`,
    `{file:${path.join(data.source, "relative.txt").replaceAll("\\", "/")}}`,
    "{env:EXAMPLE_TOKEN}",
  ])
})
