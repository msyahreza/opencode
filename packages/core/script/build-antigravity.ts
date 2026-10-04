import { join, resolve } from "node:path"
import { Schema } from "effect"

const [output] = process.argv.slice(2)
if (!output) throw new Error("Provide the output filename for the Antigravity OAuth bundle")
const local = join(import.meta.dir, "../../../tmp/antigravity-oauth.json")
const input =
  process.env.OPENCODE_ANTIGRAVITY_CLIENT_ID || process.env.OPENCODE_ANTIGRAVITY_CLIENT_SECRET
    ? {
        client_id: process.env.OPENCODE_ANTIGRAVITY_CLIENT_ID,
        client_secret: process.env.OPENCODE_ANTIGRAVITY_CLIENT_SECRET,
      }
    : (await Bun.file(local).exists())
      ? await Bun.file(local).json()
      : undefined
if (!input)
  throw new Error("Set both Antigravity OAuth client environment variables or create tmp/antigravity-oauth.json")
const client = Schema.decodeUnknownSync(
  Schema.Struct({ client_id: Schema.NonEmptyString, client_secret: Schema.NonEmptyString }),
)(input)
const bundle = await Bun.build({
  entrypoints: [join(import.meta.dir, "../src/plugin/provider/antigravity.ts")],
  target: "bun",
  format: "esm",
  define: {
    "process.env.OPENCODE_ANTIGRAVITY_CLIENT_ID": JSON.stringify(client.client_id),
    "process.env.OPENCODE_ANTIGRAVITY_CLIENT_SECRET": JSON.stringify(client.client_secret),
  },
})
if (!bundle.success) throw new AggregateError(bundle.logs, "Antigravity OAuth bundle failed")
if (bundle.outputs.length !== 1) throw new Error("Expected one Antigravity OAuth bundle")
await Bun.write(resolve(output), bundle.outputs[0])
console.log("Built the Antigravity OAuth plugin using local client settings.")
