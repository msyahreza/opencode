import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { Credential } from "@opencode/schema/credential"
import { Integration } from "@opencode/schema/integration"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { createAntigravityProvider, preserveSignatures, signatureStore, transport } from "../../src/plugin/provider/antigravity-sdk"

const credential = () => Credential.OAuth.make({
  type: "oauth", methodID: Integration.MethodID.make("antigravity-browser"),
  access: "dummy-access", refresh: "dummy-refresh", expires: 0, metadata: { project: "dummy-project" },
})
const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "Fixture" }] }]

test("native SDK forwards high thinking, separates summaries, and uses generateContent for both response modes", async () => {
  const bodies: string[] = []
  const http = HttpClient.make((request) => Effect.gen(function* () {
    expect(request.url).toEndWith("/v1internal:generateContent")
    expect(request.headers.authorization).toBe("Bearer dummy-access")
    const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
    bodies.push(yield* Effect.promise(() => web.text()))
    return HttpClientResponse.fromWeb(request, Response.json({ response: {
      candidates: [{ content: { parts: [{ thought: true, text: "Fixture thinking" }, { text: "Fixture answer" }] }, finishReason: "STOP" }],
    } }))
  }))
  const language = createAntigravityProvider({ credential: async () => credential(), signatureDatabase: ":memory:" }, http)("gemini-3.8-flash-tiered")
  const options = { prompt, providerOptions: { antigravity: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } } } }
  const generated = await language.doGenerate(options)
  expect(generated.content).toContainEqual(expect.objectContaining({ type: "reasoning", text: "Fixture thinking" }))
  expect(generated.content.filter(part => part.type === "text")).toEqual([{ type: "text", text: "Fixture answer" }])
  const streamed = await language.doStream(options)
  const parts = await Array.fromAsync(streamed.stream)
  expect(parts).toContainEqual(expect.objectContaining({ type: "reasoning-delta", delta: "Fixture thinking" }))
  expect(parts).toContainEqual(expect.objectContaining({ type: "text-delta", delta: "Fixture answer" }))
  for (const body of bodies) expect(JSON.parse(body).request.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "high" })
})

test("native SDK resolves the current account for every request and stops after disconnect", async () => {
  let account: Credential.OAuth | undefined = credential()
  const tokens: string[] = []
  const http = HttpClient.make(request => {
    tokens.push(request.headers.authorization)
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ response: { candidates: [{ content: { parts: [{ text: "Fixture" }] }, finishReason: "STOP" }] } })))
  })
  const language = createAntigravityProvider({ credential: async () => account, signatureDatabase: ":memory:" }, http)("gemini-3-flash")
  await language.doGenerate({ prompt })
  account = { ...account, access: "switched-access" }
  await language.doGenerate({ prompt })
  account = undefined
  await expect(language.doGenerate({ prompt })).rejects.toThrow("Connect Antigravity")
  expect(tokens).toEqual(["Bearer dummy-access", "Bearer switched-access"])
})

test("recreated SDK restores signed streamed tool calls from SQLite when history omits provider metadata", async () => {
  const database = new Database(":memory:")
  const bodies: string[] = []
  const http = HttpClient.make(request => Effect.gen(function* () {
    const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
    bodies.push(yield* Effect.promise(() => web.text()))
    const parts = bodies.length === 1 ? [{ functionCall: { name: "read", args: { path: "probe.txt" } }, thoughtSignature: "signed-v2-tool" }] : [{ text: "Done" }]
    return HttpClientResponse.fromWeb(request, Response.json({ response: { candidates: [{ content: { parts }, finishReason: "STOP" }] } }))
  }))
  const language = () => preserveSignatures(createGoogleGenerativeAI({ apiKey: "fixture", fetch: transport("gemini-3-flash", async () => credential(), http) })("gemini-3-flash"), signatureStore(database))
  try {
    const first = await language().doStream({ prompt })
    const call = (await Array.fromAsync(first.stream)).find(part => part.type === "tool-call")
    if (!call || call.type !== "tool-call") throw new Error("Expected fixture tool call")
    const result = await language().doGenerate({ prompt: [
      ...prompt,
      { role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: "read", input: { path: "probe.txt" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: "read", output: { type: "text", value: "fixture tool result" } }] },
    ] })
    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "Done" }))
    expect(bodies[1]).toContain('"thoughtSignature":"signed-v2-tool"')
    expect(bodies[1]).toContain("fixture tool result")
  } finally { database.close() }
})
