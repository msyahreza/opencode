import path from "node:path"
import type { Configuration } from "electron-builder"
import base from "./electron-builder.config"
import metadata from "./package.json"

export default {
  ...base,
  appId: "local.opencode.antigravity.desktop",
  productName: "OpenCode Antigravity",
  artifactName: "OpenCode-Antigravity-${version}-${arch}-Setup.${ext}",
  directories: { ...base.directories, output: "dist-antigravity" },
  extraMetadata: {
    ...base.extraMetadata,
    version: process.env.OPENCODE_ANTIGRAVITY_RELEASE_VERSION ?? `${metadata.version}-antigravity.3`,
  },
  files: [...(base.files ?? []), "!resources/antigravity-sdk.mjs", "!resources/antigravity-plugin{,/**/*}"],
  extraResources: [
    ...(Array.isArray(base.extraResources) ? base.extraResources : []),
    { from: "resources/antigravity-sdk.mjs", to: "antigravity-sdk.mjs" },
    { from: "resources/antigravity-plugin", to: "antigravity-plugin" },
  ],
  // This private build uses manual installers until its own update feed exists.
  publish: null,
  protocols: [],
  nsis: {
    ...base.nsis,
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    runAfterFinish: false,
    shortcutName: "OpenCode Antigravity",
    uninstallDisplayName: "OpenCode Antigravity",
  },
  afterPack: async (context) => {
    await base.afterPack?.(context)
    const fs = await import("node:fs/promises")
    const resources = context.packager.getResourcesDir(context.appOutDir)
    for (const filename of ["antigravity-sdk.mjs", "antigravity-plugin/index.js", "antigravity-plugin/package.json"])
      if (!(await fs.stat(path.join(resources, filename))).size) throw new Error(`Missing Antigravity resource: ${filename}`)
  },
} satisfies Configuration
