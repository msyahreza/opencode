import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Schema } from "effect"

const [configHome, pluginDirectory, sdkFile] = process.argv.slice(2)
if (!configHome || !pluginDirectory || !sdkFile)
  throw new Error("Provide the config home, plugin directory, and SDK file")
const filename = join(resolve(configHome), "opencode", "opencode.json")
const record = Schema.Record(Schema.String, Schema.Unknown)
const existing = (await Bun.file(filename).exists())
  ? Schema.decodeUnknownSync(Schema.fromJsonString(record))(await Bun.file(filename).text())
  : {}
const providers = { ...Schema.decodeUnknownSync(record)(existing.providers ?? {}) }
// Replace the earlier config-only Antigravity shim with the native OAuth plugin.
delete providers.antigravity
const plugins = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Union([Schema.String, Schema.Struct({ package: Schema.String, options: Schema.optional(record) })]),
  ),
)(existing.plugins ?? [])
const directory = pathToFileURL(resolve(pluginDirectory)).href
// A changed bundle must also get a fresh ESM import in the running daemon.
const sdk = pathToFileURL(resolve(sdkFile))
sdk.searchParams.set("v", Bun.hash(await Bun.file(sdkFile).arrayBuffer()).toString(16))
await Bun.write(
  filename,
  JSON.stringify(
    {
      ...existing,
      providers,
      plugins: [
        ...plugins.filter((item) => (typeof item === "string" ? item : item.package) !== directory),
        { package: directory, options: { sdk: sdk.href } },
      ],
      model: existing.model ?? "antigravity/gemini-3-flash",
    },
    null,
    2,
  ),
)
console.log("Antigravity Google OAuth is configured in desktop 2.0.")
