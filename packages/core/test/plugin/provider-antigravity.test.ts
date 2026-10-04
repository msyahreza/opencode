import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { AntigravityPlugin, oauthMethods, reasoning } from "@opencode/core/plugin/provider/antigravity"
import { Provider } from "@opencode/core/provider"
import { it, testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const oauthClient = { client_id: "dummy-client", client_secret: "dummy-client-secret" }

const recorded = () => {
  const requests: Array<{ url: string; body: string; authorization?: string }> = []
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
      requests.push({
        url: request.url,
        body: yield* Effect.promise(() => web.text()),
        authorization: request.headers.authorization,
      })
      const body = request.url.includes("oauth2.googleapis.com/token")
        ? { access_token: "dummy-access", refresh_token: "dummy-refresh", expires_in: 3600 }
        : request.url.includes("loadCodeAssist")
          ? { cloudaicompanionProject: { id: "dummy-project" } }
          : request.url.includes("fetchAvailableModels")
            ? {
                models: {
                  "gemini-3-flash": { displayName: "Gemini Flash", maxTokens: 123456, maxOutputTokens: 8192 },
                  "gemini-image": { displayName: "Image" },
                },
              }
            : { email: "dummy@example.test" }
      return HttpClientResponse.fromWeb(request, Response.json(body))
    }),
  )
  return { http, requests }
}

describe("Antigravity OAuth", () => {
  it.live("accepts only the matching callback and exchanges its PKCE verifier", () =>
    Effect.gen(function* () {
      const fixture = recorded()
      const authorization = yield* oauthMethods(fixture.http, 0, oauthClient)[0].authorize({})
      if (authorization.mode !== "auto") throw new Error("Expected browser OAuth")
      const url = new URL(authorization.url)
      expect(url.origin).toBe("https://accounts.google.com")
      expect(url.searchParams.get("client_id")).toBe(oauthClient.client_id)
      expect(url.searchParams.get("code_challenge_method")).toBe("S256")
      expect(url.searchParams.get("access_type")).toBe("offline")
      const redirect = url.searchParams.get("redirect_uri")!
      const bad = yield* Effect.promise(() => fetch(`${redirect}?code=bad&state=wrong`))
      expect(bad.status).toBe(400)
      expect(fixture.requests).toHaveLength(0)
      const good = yield* Effect.promise(() =>
        fetch(`${redirect}?${new URLSearchParams({ code: "dummy-code", state: url.searchParams.get("state")! })}`),
      )
      expect(good.status).toBe(200)
      const credential = yield* authorization.callback
      expect(credential).toMatchObject({
        type: "oauth",
        access: "dummy-access",
        refresh: "dummy-refresh",
        metadata: {
          project: "dummy-project",
          email: "dummy@example.test",
          models: [{ id: "gemini-3-flash", context: 123456, output: 8192 }],
        },
      })
      const token = new URLSearchParams(fixture.requests[0].body)
      expect(token.get("code")).toBe("dummy-code")
      expect(token.get("client_id")).toBe(oauthClient.client_id)
      expect(token.get("client_secret")).toBe(oauthClient.client_secret)
      expect(token.get("redirect_uri")).toBe(redirect)
      expect(
        createHash("sha256")
          .update(token.get("code_verifier") ?? "")
          .digest("base64url"),
      ).toBe(url.searchParams.get("code_challenge") ?? "")
      expect(fixture.requests[1].authorization).toBe("Bearer dummy-access")
      expect(JSON.parse(fixture.requests[2].body)).toEqual({ project: "dummy-project" })
    }),
  )

  it.effect("validates state and localhost origin for manual completion", () =>
    Effect.gen(function* () {
      const fixture = recorded()
      const authorization = yield* oauthMethods(fixture.http, 51121, oauthClient)[1].authorize({})
      if (authorization.mode !== "code") throw new Error("Expected manual OAuth")
      const url = new URL(authorization.url)
      const state = url.searchParams.get("state")!
      const invalid = yield* authorization
        .callback(`http://127.0.0.1:51121/oauth-callback?code=bad&state=wrong`)
        .pipe(Effect.flip)
      expect(String(invalid)).toContain("state")
      const foreign = yield* authorization
        .callback(`https://example.test/oauth-callback?code=bad&state=${state}`)
        .pipe(Effect.flip)
      expect(String(foreign)).toContain("localhost")
      expect(fixture.requests).toHaveLength(0)
      const credential = yield* authorization.callback(
        `http://127.0.0.1:51121/oauth-callback?code=dummy&state=${state}`,
      )
      expect(credential.metadata?.project).toBe("dummy-project")
    }),
  )

  it.effect("refreshes expired access while preserving the refresh token and project", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.gen(function* () {
          const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
          const body = new URLSearchParams(yield* Effect.promise(() => web.text()))
          expect(body.get("grant_type")).toBe("refresh_token")
          expect(body.get("refresh_token")).toBe("old-refresh")
          expect(body.get("client_id")).toBe(oauthClient.client_id)
          expect(body.get("client_secret")).toBe(oauthClient.client_secret)
          return HttpClientResponse.fromWeb(request, Response.json({ access_token: "new-access", expires_in: 3600 }))
        }),
      )
      const method = oauthMethods(http, 51121, oauthClient)[0]
      const credential = yield* method.refresh!({
        type: "oauth",
        methodID: Integration.MethodID.make(method.method.id),
        access: "old",
        refresh: "old-refresh",
        expires: 0,
        metadata: { project: "project" },
      })
      expect(credential).toMatchObject({
        access: "new-access",
        refresh: "old-refresh",
        metadata: { project: "project" },
      })
    }),
  )

  it.effect("rejects an unconfigured build before opening a listener or sending credentials", () =>
    Effect.gen(function* () {
      const fixture = recorded()
      const methods = oauthMethods(fixture.http, 0, { client_id: "", client_secret: "" })
      for (const method of methods) {
        const error = yield* method.authorize({}).pipe(Effect.flip)
        expect(String(error)).toContain("client settings are missing")
      }
      const error = yield* methods[0].refresh!({
        type: "oauth",
        methodID: Integration.MethodID.make("antigravity-browser"),
        access: "dummy",
        refresh: "dummy",
        expires: 0,
      }).pipe(Effect.flip)
      expect(String(error)).toContain("client settings are missing")
      expect(fixture.requests).toHaveLength(0)
    }),
  )
})

const pluginTest = testEffect(PluginTestLayer)
describe("Antigravity catalog", () => {
  pluginTest.effect("registers desktop OAuth methods and uses the connected account's models", () =>
    Effect.gen(function* () {
      const providerID = Provider.ID.make("antigravity")
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      yield* credentials.create({
        integrationID: Integration.ID.make(providerID),
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("antigravity-browser"),
          access: "dummy",
          refresh: "dummy",
          expires: Number.MAX_SAFE_INTEGER,
          metadata: {
            project: "dummy-project",
            models: [{ id: "gemini-3.8-flash-tiered", name: "Account model", context: 123456, output: 8192 }],
          },
        }),
      })
      const plugin = yield* Plugin.Service
      const host = yield* PluginHost.make(plugin)
      yield* AntigravityPlugin.effect({ ...host, options: { sdk: "file:///dummy-antigravity-sdk.mjs" } })
      expect((yield* integrations.get(Integration.ID.make(providerID)))?.methods.map((method) => method.type)).toEqual([
        "oauth",
        "oauth",
      ])
      const providers = yield* Provider.Service
      const model = (yield* providers.snapshot()).records
        .get(providerID)
        ?.models.get(Model.ID.make("gemini-3.8-flash-tiered"))
      expect(model).toMatchObject({
        name: "Account model",
        limit: { context: 123456, output: 8192 },
        settings: { thinkingConfig: { includeThoughts: true } },
      })
      expect(model?.variants.map((variant) => String(variant.id))).toEqual(["low", "medium", "high"])
      expect(model?.variants[2].settings).toEqual({ thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } })
    }),
  )
})

test("Gemini reasoning levels exclude unsupported levels and leave other model families unchanged", () => {
  expect(reasoning("gemini-3.7-flash-tiered").variants.map((variant) => String(variant.id))).toEqual([
    "low",
    "medium",
    "high",
  ])
  expect(reasoning("gemini-3-pro-preview").variants.map((variant) => String(variant.id))).toEqual(["low", "high"])
  expect(reasoning("gemini-3.1-pro-high").variants.map((variant) => String(variant.id))).toEqual([
    "low",
    "medium",
    "high",
  ])
  expect(reasoning("gemini-3-flash").variants.map((variant) => String(variant.id))).toEqual([
    "minimal",
    "low",
    "medium",
    "high",
  ])
  expect(reasoning("gemini-custom")).toEqual({ variants: [] })
  expect(reasoning("claude-sonnet-4-6")).toEqual({ variants: [] })
})
