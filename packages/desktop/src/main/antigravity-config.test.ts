import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { configureAntigravity } from "./antigravity-config"

test("relocates the packaged plugin while preserving other providers, settings and the selected model", () => {
  const resources = path.resolve("tmp/Laptop Install/resources")
  const config = configureAntigravity({
    model: "antigravity/gemini-3.8-flash-tiered#high",
    providers: { other: { settings: { value: "fixture" } }, antigravity: { package: "obsolete-shim" } },
    plugins: ["other-plugin", { package: "file:///D:/old/resources/antigravity-plugin", options: { sdk: "old" } }],
    username: "fixture",
  }, resources, new Uint8Array([1, 2]))
  expect(config.providers).toEqual({ other: { settings: { value: "fixture" } } })
  expect(config.model).toBe("antigravity/gemini-3.8-flash-tiered#high")
  expect(config.plugins).toHaveLength(2)
  expect(config.plugins[0]).toBe("other-plugin")
  const plugin = config.plugins[1]
  if (typeof plugin === "string") throw new Error("Expected packaged plugin")
  expect(fileURLToPath(plugin.package)).toBe(path.join(resources, "antigravity-plugin"))
  expect(fileURLToPath(String(plugin.options?.sdk))).toBe(path.join(resources, "antigravity-sdk.mjs"))
  expect(configureAntigravity(config, resources, new Uint8Array([1, 2]))).toEqual(config)
  expect(configureAntigravity(config, resources, new Uint8Array([3])).plugins).not.toEqual(config.plugins)
})

test("fresh laptop config has OAuth plugin and no shipped account credentials", () => {
  const config = configureAntigravity({}, path.resolve("tmp/resources"), new Uint8Array([1]))
  expect(config.model).toBe("antigravity/gemini-3-flash")
  expect(config.providers).toEqual({})
  expect(config.plugins).toHaveLength(1)
  expect(JSON.stringify(config)).not.toContain("refresh_token")
})
