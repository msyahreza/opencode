import { expect, test } from "bun:test"
import config from "./electron-builder.antigravity.config"

test("Windows installer has its own identity, bundles the OAuth runtime, and keeps official updates and links separate", () => {
  expect(config.appId).toBe("local.opencode.antigravity.desktop")
  expect(config.productName).toBe("OpenCode Antigravity")
  expect(config.publish).toBeNull()
  expect(config.protocols).toEqual([])
  expect(config.extraResources).toContainEqual({ from: "resources/antigravity-sdk.mjs", to: "antigravity-sdk.mjs" })
  expect(config.extraResources).toContainEqual({ from: "resources/antigravity-plugin", to: "antigravity-plugin" })
  expect(config.nsis?.shortcutName).toBe("OpenCode Antigravity")
  expect(config.nsis?.runAfterFinish).toBe(false)
})
