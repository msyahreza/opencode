import { createServer } from "node:http"
import { createHash } from "node:crypto"
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { Clock, Deferred, Effect, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Credential } from "@opencode/schema/credential"
import { Model } from "@opencode/schema/model"
import { Integration } from "@opencode/schema/integration"
import { OauthCallbackPage } from "../../oauth/page"
import { define } from "@opencode/plugin/effect/plugin"
import { Provider } from "@opencode/schema/provider"

type SDK = {
  createAntigravityProvider: (options: {
    credential: () => Promise<Credential.OAuth | undefined>
  }) => (modelID: string) => LanguageModelV3
}

export function createAntigravityPlugin(client?: HttpClient.HttpClient, port = 51121) {
  return define({
    id: "opencode.provider.antigravity",
    effect: Effect.fn(function* (ctx) {
      const http = client ?? (yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer)))
      const sdk = ctx.options.sdk
      if (typeof sdk !== "string") return yield* Effect.die(new Error("Antigravity SDK path is required"))
      const resolve = Effect.fn(function* () {
        const connection = yield* ctx.integration.connection.active(integrationID)
        const value = connection ? yield* ctx.integration.connection.resolve(connection) : undefined
        return value?.type === "oauth" ? value : undefined
      })
      let value: Credential.OAuth | undefined
      const load = Effect.fn(function* () {
        value = yield* resolve().pipe(Effect.orElseSucceed(() => undefined))
      })
      yield* ctx.integration.transform((editor) => {
        editor.update(integrationID, (item) => {
          item.name = "Antigravity"
        })
        for (const method of oauthMethods(http, port)) editor.method.update(method)
      })
      yield* load()
      yield* ctx.provider.transform((editor) => {
        const providerID = Provider.ID.make(integrationID)
        editor.add({
          info: {
            ...Provider.Info.empty(providerID),
            integrationID: Integration.ID.make(integrationID),
            name: "Antigravity",
            package: `aisdk:${sdk}`,
            settings: { nativeOAuth: true },
          },
          models: catalogModels(value?.metadata).map((item) => ({
            ...Model.Info.default(providerID, Model.ID.make(item.id)),
            ...reasoning(item.id),
            name: item.name,
            capabilities: {
              tools: true,
              input: item.id.startsWith("gpt-oss") ? ["text"] : ["text", "image", "pdf"],
              output: ["text"],
            },
            limit: { context: item.context, output: item.output },
          })),
        })
      })
      yield* ctx.aisdk.hook(
        "language",
        Effect.fn(function* (event) {
          const module: SDK = yield* Effect.promise(() => import(sdk))
          const provider = module.createAntigravityProvider({ credential: () => Effect.runPromise(resolve()) })
          event.language = provider(event.model.modelID ?? event.model.id)
        }),
        { providerID: integrationID },
      )
      yield* ctx.event.subscribe().pipe(
        Stream.filter((event) => event.type === "integration.updated" || event.type === "credential.switched"),
        Stream.runForEach(() => load().pipe(Effect.andThen(ctx.provider.reload()))),
        Effect.forkScoped({ startImmediately: true }),
      )
    }),
  })
}

export const AntigravityPlugin = createAntigravityPlugin()
export default AntigravityPlugin

function requestHeaders() {
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux"
  const arch = process.arch === "arm64" ? "arm64" : "amd64"
  return {
    "User-Agent": `antigravity/${process.env.OPENCODE_ANTIGRAVITY_VERSION ?? "1.18.3"} ${platform}/${arch}`,
    "x-goog-api-client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "x-goog-client-metadata": '{"ideType":"ANTIGRAVITY","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
    "client-metadata": '{"ideType":"ANTIGRAVITY","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
  }
}

const integrationID = "antigravity"
// Installed-application OAuth settings are supplied by the local release build.
// User credentials are obtained only after Google consent.
const authorizeURL = "https://accounts.google.com/o/oauth2/v2/auth"
const tokenURL = "https://oauth2.googleapis.com/token"
const scopes = ["cloud-platform", "userinfo.email", "userinfo.profile", "cclog", "experimentsandconfigs"]
  .map((scope) => `https://www.googleapis.com/auth/${scope}`)
  .join(" ")

const Tokens = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.optional(Schema.NonEmptyString),
  expires_in: Schema.Finite,
})
const Project = Schema.Struct({
  cloudaicompanionProject: Schema.optional(
    Schema.Union([Schema.NonEmptyString, Schema.Struct({ id: Schema.NonEmptyString })]),
  ),
})
const CatalogModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  context: Schema.Int,
  output: Schema.Int,
})
const Models = Schema.Array(CatalogModel)
const Catalog = Schema.Struct({
  models: Schema.Record(
    Schema.String,
    Schema.Struct({
      displayName: Schema.optional(Schema.String),
      modelName: Schema.optional(Schema.String),
      maxTokens: Schema.optional(Schema.Int),
      maxOutputTokens: Schema.optional(Schema.Int),
    }),
  ),
})
const fallback = [
  "gemini-3-flash",
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
].map((id) => ({ id, name: id, context: id.startsWith("gemini") ? 1_048_576 : 200_000, output: 32_768 }))

export function catalogModels(metadata?: Credential.OAuth["metadata"]) {
  const models = Schema.decodeUnknownOption(Models)(metadata?.models)
  return models._tag === "Some" && models.value.length ? models.value : fallback
}

export function reasoning(id: string): Pick<Model.Info, "settings" | "variants"> {
  // Cloud Code adds suffixes such as "-tiered" to the Gemini model IDs.
  // Keep the supported levels specific to each documented model family.
  const levels =
    /^gemini-3\.[78]-flash(?:-|$)/.test(id) || /^gemini-3\.1-pro(?:-|$)/.test(id)
      ? ["low", "medium", "high"]
      : /^gemini-3-pro(?:-|$)/.test(id)
        ? ["low", "high"]
        : /^gemini-3(?:\.[56])?-flash(?:-|$)/.test(id) || /^gemini-3\.1-flash-lite(?:-|$)/.test(id)
          ? ["minimal", "low", "medium", "high"]
          : []
  return {
    ...(levels.length ? { settings: { thinkingConfig: { includeThoughts: true } } } : {}),
    variants: levels.map((level) => ({
      id: Model.VariantID.make(level),
      settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: level } },
    })),
  }
}

export function endpoint() {
  const url = new URL(process.env.OPENCODE_ANTIGRAVITY_ENDPOINT ?? "https://daily-cloudcode-pa.googleapis.com")
  if (url.protocol !== "https:" || url.search || url.hash || url.pathname !== "/")
    throw new Error("OPENCODE_ANTIGRAVITY_ENDPOINT must be an HTTPS origin")
  return url.origin
}

export function oauthMethods(
  http: HttpClient.HttpClient,
  port = 51121,
  settings = {
    client_id: process.env.OPENCODE_ANTIGRAVITY_CLIENT_ID ?? "",
    client_secret: process.env.OPENCODE_ANTIGRAVITY_CLIENT_SECRET ?? "",
  },
): IntegrationOAuthMethodRegistration[] {
  const configured = Effect.suspend(() =>
    settings.client_id && settings.client_secret
      ? Effect.void
      : Effect.fail(new Error("Antigravity OAuth client settings are missing from this build")),
  )
  const refresh = (value: { methodID: string; refresh: string; metadata?: Credential.OAuth["metadata"] }) =>
    configured.pipe(
      Effect.andThen(
        json(
          http,
          HttpClientRequest.post(tokenURL).pipe(
            HttpClientRequest.bodyUrlParams({ ...settings, grant_type: "refresh_token", refresh_token: value.refresh }),
          ),
          Tokens,
        ),
      ),
      Effect.flatMap((tokens) => credential(value.methodID, tokens, value.refresh, value.metadata)),
    )
  const exchange = (code: string, verifier: string, redirect: string, methodID: string) =>
    Effect.gen(function* () {
      const tokens = yield* json(
        http,
        HttpClientRequest.post(tokenURL).pipe(
          HttpClientRequest.bodyUrlParams({
            ...settings,
            grant_type: "authorization_code",
            code,
            code_verifier: verifier,
            redirect_uri: redirect,
          }),
        ),
        Tokens,
      )
      if (!tokens.refresh_token)
        return yield* Effect.fail(new Error("Google did not return an Antigravity refresh token"))
      const metadata = yield* discoverAccount(http, tokens.access_token)
      return yield* credential(methodID, tokens, tokens.refresh_token, metadata)
    })
  const prepare = Effect.fn(function* () {
    yield* configured
    const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
    const challenge = createHash("sha256").update(verifier).digest("base64url")
    const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
    return { verifier, challenge, state }
  })
  const url = (redirect: string, challenge: string, state: string) =>
    `${authorizeURL}?${new URLSearchParams({
      client_id: settings.client_id,
      response_type: "code",
      redirect_uri: redirect,
      scope: scopes,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      access_type: "offline",
      prompt: "consent",
    })}`
  const browserID = "antigravity-browser"
  const manualID = "antigravity-callback"
  return [
    {
      integrationID,
      method: { id: browserID, type: "oauth", label: "Google (Antigravity)" },
      authorize: () =>
        Effect.gen(function* () {
          const pkce = yield* prepare()
          const code = yield* Deferred.make<string, Error>()
          const server = createServer((request, response) => {
            const callback = new URL(request.url ?? "/", "http://127.0.0.1")
            if (request.method !== "GET" || callback.pathname !== "/oauth-callback") {
              response.writeHead(404).end()
              return
            }
            const result = callbackCode(callback, pkce.state)
            if (result instanceof Error) {
              response
                .writeHead(400, { "Content-Type": "text/html" })
                .end(OauthCallbackPage.error(result.message, { provider: "Antigravity" }))
              // An unrelated or stale callback must not cancel a valid login.
              if (callback.searchParams.get("state") === pkce.state) Effect.runFork(Deferred.fail(code, result))
              return
            }
            Effect.runFork(Deferred.succeed(code, result))
            response
              .writeHead(200, { "Content-Type": "text/html" })
              .end(OauthCallbackPage.success({ provider: "Antigravity" }))
          })
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              server.close()
            }),
          )
          yield* Effect.callback<void, Error>((resume) => {
            server.once("error", (error) => resume(Effect.fail(error)))
            server.listen(port, "127.0.0.1", () => resume(Effect.void))
          })
          const address = server.address()
          if (!address || typeof address === "string")
            return yield* Effect.fail(new Error("Antigravity callback listener is unavailable"))
          const redirect = `http://127.0.0.1:${address.port}/oauth-callback`
          return {
            mode: "auto" as const,
            url: url(redirect, pkce.challenge, pkce.state),
            instructions: "Complete the Google sign-in in your browser, then return to OpenCode.",
            callback: Deferred.await(code).pipe(
              Effect.flatMap((value) => exchange(value, pkce.verifier, redirect, browserID)),
            ),
          }
        }),
      refresh,
      label: (value) => (typeof value.metadata?.email === "string" ? value.metadata.email : undefined),
    },
    {
      integrationID,
      method: { id: manualID, type: "oauth", label: "Google (Antigravity, callback URL)" },
      authorize: () =>
        Effect.gen(function* () {
          const pkce = yield* prepare()
          const redirect = `http://127.0.0.1:${port}/oauth-callback`
          return {
            mode: "code" as const,
            url: url(redirect, pkce.challenge, pkce.state),
            instructions:
              "After Google sign-in, paste the full localhost callback URL from your browser's address bar.",
            callback: (input: string) =>
              Effect.gen(function* () {
                const callback = yield* Effect.try({
                  try: () => new URL(input.trim()),
                  catch: () => new Error("Paste the full Antigravity callback URL"),
                })
                if (callback.origin !== new URL(redirect).origin || callback.pathname !== "/oauth-callback")
                  return yield* Effect.fail(new Error("Use the Antigravity localhost callback URL"))
                const result = callbackCode(callback, pkce.state)
                if (result instanceof Error) return yield* Effect.fail(result)
                return yield* exchange(result, pkce.verifier, redirect, manualID)
              }),
          }
        }),
      refresh,
    },
  ]
}

function callbackCode(url: URL, state: string) {
  if (url.searchParams.get("state") !== state) return new Error("Invalid Antigravity OAuth state")
  if (url.searchParams.has("error")) return new Error("Google denied Antigravity authorization")
  return url.searchParams.get("code") || new Error("Missing Antigravity authorization code")
}

function credential(
  methodID: string,
  tokens: typeof Tokens.Type,
  refresh: string,
  metadata?: Credential.OAuth["metadata"],
) {
  return Clock.currentTimeMillis.pipe(
    Effect.map((now) =>
      Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make(methodID),
        access: tokens.access_token,
        refresh: tokens.refresh_token ?? refresh,
        expires: now + tokens.expires_in * 1000,
        metadata,
      }),
    ),
  )
}

function json<A>(
  http: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  schema: Schema.Codec<A, unknown>,
) {
  return http
    .execute(request)
    .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)))
}

function post<A>(
  http: HttpClient.HttpClient,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  schema: Schema.Codec<A, unknown>,
) {
  return HttpClientRequest.post(url).pipe(
    HttpClientRequest.setHeaders(headers),
    HttpClientRequest.schemaBodyJson(Schema.Record(Schema.String, Schema.Unknown))(body),
    Effect.flatMap((request) => json(http, request, schema)),
  )
}

function discoverAccount(http: HttpClient.HttpClient, access: string) {
  return Effect.gen(function* () {
    const headers = {
      ...requestHeaders(),
      Authorization: `Bearer ${access}`,
    }
    const project = yield* Effect.firstSuccessOf(
      [endpoint(), "https://cloudcode-pa.googleapis.com"].map((base) =>
        post(
          http,
          `${base}/v1internal:loadCodeAssist`,
          headers,
          { metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } },
          Project,
        ).pipe(
          Effect.flatMap((result) => {
            const value = result.cloudaicompanionProject
            const id = typeof value === "string" ? value : value?.id
            return id ? Effect.succeed(id) : Effect.fail(new Error("Antigravity project is missing"))
          }),
        ),
      ),
    )
    const catalog = yield* post(
      http,
      `${endpoint()}/v1internal:fetchAvailableModels`,
      headers,
      { project },
      Catalog,
    ).pipe(Effect.orElseSucceed(() => undefined))
    const profile = yield* json(
      http,
      HttpClientRequest.get("https://www.googleapis.com/oauth2/v1/userinfo?alt=json").pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${access}`),
      ),
      Schema.Struct({ email: Schema.optional(Schema.String) }),
    ).pipe(Effect.orElseSucceed(() => undefined))
    return {
      project,
      ...(profile?.email ? { email: profile.email } : {}),
      ...(catalog
        ? {
            models: Object.entries(catalog.models).flatMap(([key, item]) => {
              const id = item.modelName || key
              if (!/^(gemini|claude|gpt-oss)/.test(id) || /image|embedding/.test(id)) return []
              return [
                {
                  id,
                  name: item.displayName || id,
                  context: item.maxTokens ?? (id.startsWith("gemini") ? 1_048_576 : 200_000),
                  output: item.maxOutputTokens ?? 32_768,
                },
              ]
            }),
          }
        : {}),
    }
  })
}
