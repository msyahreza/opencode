import { createHash } from "node:crypto"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Schema } from "effect"

const record = Schema.Record(Schema.String, Schema.Unknown)
const plugins = Schema.Array(
  Schema.Union([Schema.String, Schema.Struct({ package: Schema.String, options: Schema.optional(record) })]),
)

export function configureAntigravity(config: Record<string, unknown>, resources: string, sdk: Uint8Array) {
  const providers = { ...Schema.decodeUnknownSync(record)(config.providers ?? {}) }
  delete providers.antigravity
  const directory = pathToFileURL(path.join(resources, "antigravity-plugin")).href
  const url = pathToFileURL(path.join(resources, "antigravity-sdk.mjs"))
  url.searchParams.set("v", createHash("sha256").update(sdk).digest("hex"))
  const existing = Schema.decodeUnknownSync(plugins)(config.plugins ?? [])
  return {
    ...config,
    providers,
    plugins: [
      ...existing.filter((item) => {
        const spec = typeof item === "string" ? item : item.package
        return !spec.replace(/\\/g, "/").replace(/\/$/, "").endsWith("/antigravity-plugin")
      }),
      { package: directory, options: { sdk: url.href } },
    ],
    model: config.model ?? "antigravity/gemini-3-flash",
  }
}
