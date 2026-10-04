import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { app } from "electron"
import { Schema } from "effect"
import { configureAntigravity } from "./antigravity-config"
import { importExistingOpenCode } from "./antigravity-import"

const record = Schema.Record(Schema.String, Schema.Unknown)

// The CLI consumes JSON config and loads plugin files outside Electron's asar.
// Derive these paths on the target machine; user credentials stay in its database.
export async function prepareAntigravity() {
  const resources = app.isPackaged
    ? process.resourcesPath
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../resources")
  const filename = process.env.OPENCODE_CONFIG!
  const service = path.join(path.dirname(filename), "service.json")
  await mkdir(path.dirname(filename), { recursive: true })
  const config = await readConfig(filename)
  const imported = await importExistingOpenCode(path.dirname(filename), config, {
    home: homedir(),
    appData: process.env.APPDATA,
    path: process.env.PATH,
    configDirectory: process.env.OPENCODE_ANTIGRAVITY_IMPORT_DIR,
    configFile: process.env.OPENCODE_ANTIGRAVITY_IMPORT_FILE,
  })
  const next = configureAntigravity(imported.config, resources, await readFile(path.join(resources, "antigravity-sdk.mjs")))
  if (JSON.stringify(next) !== JSON.stringify(config)) await writeConfig(filename, next)
  const settings = await readConfig(service)
  if (settings.port !== undefined) return
  // Persist one free port so contenders for this private daemon elect one server.
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("Private service port is unavailable"))
      server.close(() => resolve(address.port))
    })
  })
  await writeConfig(service, { ...settings, hostname: "127.0.0.1", port })
}

async function readConfig(filename: string) {
  const text = await readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  return text === undefined ? {} : Schema.decodeUnknownSync(Schema.fromJsonString(record))(text)
}

async function writeConfig(filename: string, config: Record<string, unknown>) {
  const temp = `${filename}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(config, null, 2), { mode: 0o600 })
  await rename(temp, filename)
}
