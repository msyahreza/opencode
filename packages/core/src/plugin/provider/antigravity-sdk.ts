import { createGoogleGenerativeAI } from "@ai-sdk/google"
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { Credential } from "@opencode/schema/credential"
import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { Effect, ManagedRuntime, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { endpoint } from "./antigravity"

const record = Schema.Record(Schema.String, Schema.Unknown)
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(record))
const object = Schema.decodeUnknownOption(record)

export function createAntigravityProvider(options: {
  nativeOAuth?: boolean
  credential?: () => Promise<Credential.OAuth | undefined>
  signatureDatabase?: string
} = {}, client?: HttpClient.HttpClient) {
  const resolve = options.credential
  if (!resolve) {
    const language = () => { throw new Error("Antigravity OAuth plugin is required") }
    return Object.assign(language, { languageModel: language, chat: language })
  }
  const http = client ?? ManagedRuntime.make(FetchHttpClient.layer).runSync(HttpClient.HttpClient)
  const filename = options.signatureDatabase ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode", "antigravity-signatures.db")
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true })
  const signatures = signatureStore(new Database(filename, { create: true }))
  const language = (modelID: string) => preserveSignatures(
    createGoogleGenerativeAI({ apiKey: "antigravity-oauth", fetch: transport(modelID, resolve, http) })(modelID), signatures,
  )
  return Object.assign(language, { languageModel: language, chat: language })
}

export function transport(modelID: string, resolve: () => Promise<Credential.OAuth | undefined>, http: HttpClient.HttpClient): typeof fetch {
  return Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body !== "string") throw new Error("Antigravity requires a JSON model request")
    const body = decode(init.body)
    const credential = await resolve()
    if (!credential) throw new Error("Connect Antigravity using Google OAuth")
    const project = credential.metadata?.project
    if (typeof project !== "string" || !project.trim()) throw new Error("Reconnect Antigravity to resolve its Cloud Code project")
    const tools = Array.isArray(body.tools) ? body.tools.map((input) => {
      const tool = object(input)
      if (tool._tag === "None" || !Array.isArray(tool.value.functionDeclarations)) return input
      return { ...tool.value, functionDeclarations: tool.value.functionDeclarations.map((input) => {
        const declaration = object(input)
        if (declaration._tag === "None") return input
        const fields = { ...declaration.value }
        const schema = object(fields.parametersJsonSchema ?? fields.parameters)
        delete fields.parametersJsonSchema
        return { ...fields, ...(schema._tag === "Some" ? { parameters: compatibleSchema(schema.value, modelID) } : {}) }
      }) }
    }) : undefined
    return Effect.runPromise(Effect.gen(function* () {
      const request = yield* HttpClientRequest.post(`${endpoint()}/v1internal:generateContent`).pipe(
        HttpClientRequest.setHeaders({ ...headers(), Authorization: `Bearer ${credential.access}`, "x-goog-request-params": `project=${project}` }),
        HttpClientRequest.schemaBodyJson(Schema.Unknown)({ model: modelID, project, user_prompt_id: crypto.randomUUID(), request: { ...body, ...(tools ? { tools } : {}) } }),
      )
      const result = yield* http.execute(request)
      const text = yield* result.text
      if (result.status < 200 || result.status >= 300) return new Response(text, { status: result.status, headers: result.headers })
      const response = Schema.decodeUnknownSync(record)(decode(text).response)
      const url = input instanceof Request ? input.url : input.toString()
      return url.includes(":streamGenerateContent")
        ? new Response(`data: ${JSON.stringify(response)}\n\n`, { headers: { "Content-Type": "text/event-stream" } })
        : Response.json(response)
    }), { signal: init.signal ?? undefined })
  }, { preconnect: globalThis.fetch.preconnect })
}

function headers() {
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux"
  const arch = process.arch === "arm64" ? "arm64" : "amd64"
  const metadata = '{"ideType":"ANTIGRAVITY","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}'
  return {
    "User-Agent": `antigravity/1.18.3 ${platform}/${arch}`,
    "x-goog-api-client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "x-goog-client-metadata": metadata,
    "client-metadata": metadata,
  }
}

function compatibleSchema(schema: Readonly<Record<string, unknown>>, model: string): Record<string, unknown> {
  const fields = Object.fromEntries(Object.entries(schema).flatMap(([key, value]) => {
    if (model.startsWith("gpt-oss") && /^(min|max)(Items|Length|Properties)$/.test(key)) return []
    const map = (input: unknown): unknown => {
      const value = object(input)
      return value._tag === "Some" ? compatibleSchema(value.value, model) : Array.isArray(input) ? input.map(map) : input
    }
    return [[key, map(value)]]
  }))
  if (!model.startsWith("claude")) return fields
  const combiner = ["anyOf", "oneOf", "allOf"].find((key) => Array.isArray(fields[key]))
  if (!combiner) return fields
  const branches = fields[combiner]
  if (!Array.isArray(branches)) return fields
  const first = object(branches[0])
  return first._tag === "Some" ? { ...Object.fromEntries(Object.entries(fields).filter(([key]) => key !== combiner)), ...first.value } : fields
}

export function signatureStore(database: Database) {
  database.exec("PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS signature (call_id TEXT PRIMARY KEY, value TEXT NOT NULL)")
  return {
    get: (id: string) => database.query<{ value: string }, [string]>("SELECT value FROM signature WHERE call_id = ?").get(id)?.value,
    set: (id: string, value: string) => { database.query("INSERT OR REPLACE INTO signature VALUES (?, ?)").run(id, value) },
  }
}

export function preserveSignatures(model: LanguageModelV3, signatures: { get(id: string): string | undefined; set(id: string, value: string): void } = new Map()): LanguageModelV3 {
  const replay = (options: LanguageModelV3CallOptions) => ({
    ...options,
    providerOptions: { ...options.providerOptions, google: { ...options.providerOptions?.antigravity, ...options.providerOptions?.google } },
    prompt: options.prompt.map((message) => message.role !== "assistant" ? message : {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool-call") return part
        const signature = signatures.get(part.toolCallId)
        return signature ? { ...part, providerOptions: { ...part.providerOptions, google: { ...part.providerOptions?.google, thoughtSignature: signature } } } : part
      }),
    }),
  })
  const remember = (part: { type: string; toolCallId?: string; providerMetadata?: Record<string, Record<string, unknown>> }) => {
    const signature = part.providerMetadata?.google?.thoughtSignature
    if (part.type === "tool-call" && part.toolCallId && typeof signature === "string") signatures.set(part.toolCallId, signature)
  }
  return new Proxy(model, {
    get(target, property) {
      if (property === "doGenerate") return async (options: LanguageModelV3CallOptions) => {
        const result = await target.doGenerate(replay(options))
        result.content.forEach(remember)
        return result
      }
      if (property === "doStream") return async (options: LanguageModelV3CallOptions) => {
        const result = await target.doStream(replay(options))
        return { ...result, stream: result.stream.pipeThrough(new TransformStream({ transform(part, controller) { remember(part); controller.enqueue(part) } })) }
      }
      return target[property as keyof LanguageModelV3]
    },
  })
}
