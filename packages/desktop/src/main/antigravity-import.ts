import { execFile } from "node:child_process"
import { copyFile, cp, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Schema } from "effect"
import { parse, type ParseError } from "jsonc-parser"

const record = Schema.Record(Schema.String, Schema.Unknown)
const decode = Schema.decodeUnknownSync(record)
const exec = promisify(execFile)
const assets = ["AGENTS.md", "skill", "skills", "agent", "agents", "command", "commands", "mode", "modes", "tools", "themes"]

export interface ImportOptions {
  home: string
  appData?: string
  path?: string
  configDirectory?: string
  configFile?: string
  desktop?: readonly string[]
}

export async function importExistingOpenCode(directory: string, current: Record<string, unknown>, options: ImportOptions) {
  const marker = path.join(directory, "antigravity-import.json")
  const previous = await readFile(marker, "utf8").catch(() => undefined)
  if (previous) {
    const marker = Schema.decodeUnknownOption(record)(parse(previous))
    if (marker._tag === "Some" && marker.value.status === "imported") return { config: current }
  }
  const roots = [...new Set([
    ...(options.configDirectory ? [path.resolve(options.configDirectory)] : [
      ...(options.appData ? [path.join(options.appData, "opencode")] : []),
      path.join(options.home, ".config", "opencode"),
    ]),
    ...(options.configFile ? [path.dirname(path.resolve(options.configFile))] : []),
  ])].filter((root) => path.resolve(root).toLowerCase() !== path.resolve(directory).toLowerCase())
  const installations = {
    cli: (await Promise.all((options.path ?? "").split(path.delimiter).filter(Boolean).flatMap((root) =>
      ["opencode.exe", "opencode.cmd", "opencode.ps1", "opencode"].map(async (name) => {
        const filename = path.join(root.replace(/^"|"$/g, ""), name)
        return (await stat(filename).catch(() => undefined))?.isFile() ? filename : undefined
      }),
    ))).filter((filename) => filename !== undefined),
    desktop: options.desktop ?? await detectDesktop(),
  }
  const report = {
    status: "not-found",
    checkedAt: new Date().toISOString(),
    installations,
    sources: [] as string[],
    copied: [] as string[],
    skippedPlugins: [] as string[],
    issues: [] as { path: string; reason: string }[],
  }
  const configs: Record<string, unknown>[] = []
  for (const root of roots) {
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      const filename = path.join(root, name)
      const text = await readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") report.issues.push({ path: filename, reason: error.code ?? "read" })
        return undefined
      })
      if (text === undefined) continue
      const errors: ParseError[] = []
      const input: unknown = parse(text, errors, { allowTrailingComma: true })
      const value = Schema.decodeUnknownOption(record)(input)
      if (errors.length || value._tag === "None") {
        report.issues.push({ path: filename, reason: "invalid-jsonc" })
        continue
      }
      try {
        configs.push(relocateConfig(value.value, root, report.skippedPlugins))
        report.sources.push(filename)
      } catch {
        report.issues.push({ path: filename, reason: "invalid-plugin-config" })
      }
    }
    const explicit = options.configFile && path.resolve(options.configFile)
    if (explicit && path.dirname(explicit) === root && !["opencode.json", "opencode.jsonc"].includes(path.basename(explicit))) {
      const text = await readFile(explicit, "utf8").catch(() => undefined)
      const errors: ParseError[] = []
      const input: unknown = text === undefined ? undefined : parse(text, errors, { allowTrailingComma: true })
      const value = Schema.decodeUnknownOption(record)(input)
      if (!errors.length && value._tag === "Some") {
        try {
          configs.push(relocateConfig(value.value, root, report.skippedPlugins))
          report.sources.push(explicit)
        } catch {
          report.issues.push({ path: explicit, reason: "invalid-plugin-config" })
        }
      }
    }
    // Keep package roots in place so local plugins can resolve their existing dependencies.
    const localPlugins = (await Promise.all(["plugin", "plugins"].map(async (name) => {
      const folder = path.join(root, name)
      return (await readdir(folder, { withFileTypes: true }).catch(() => [])).flatMap((item) => {
        const target = path.join(folder, item.name)
        if (item.isDirectory() && !isAntigravity(target)) {
          const spec = pathToFileURL(target).href
          const configured = configs.some((config) => Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(config.plugins ?? []).some((plugin) => {
            if (typeof plugin === "string") return plugin === spec
            const value = Schema.decodeUnknownOption(record)(plugin)
            return value._tag === "Some" && value.value.package === spec
          }))
          return configured ? [] : [spec]
        }
        report.skippedPlugins.push(target)
        return []
      })
    }))).flat()
    if (localPlugins.length) configs.push({ plugins: localPlugins })
  }
  for (const root of roots.toReversed()) for (const name of assets) {
    const source = path.join(root, name)
    const info = await stat(source).catch(() => undefined)
    if (!info) continue
    const target = path.join(directory, name)
    await mkdir(directory, { recursive: true })
    await (info.isDirectory()
      ? cp(source, target, { recursive: true, force: false, errorOnExist: false, dereference: true })
      : copyFile(source, target, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error })
    ).then(() => { report.copied.push(source) }).catch((error: NodeJS.ErrnoException) => {
      report.issues.push({ path: source, reason: error.code ?? "copy" })
    })
  }
  const imported = configs.reduce(mergeConfig, {})
  // Keep this build's default model and updater. Other providers remain available after login.
  delete imported.model
  delete imported.autoupdate
  delete imported.update
  const config = mergeConfig(imported, current)
  const found = report.sources.length > 0 || report.copied.length > 0 || configs.length > 0
  report.status = report.issues.length ? "partial" : found ? "imported" : "not-found"
  await mkdir(directory, { recursive: true })
  if (JSON.stringify(config) !== JSON.stringify(current)) {
    const filename = path.join(directory, "opencode.json")
    await writeFile(`${filename}.before-import`, JSON.stringify(current, null, 2), { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    })
    await writeFile(`${filename}.${process.pid}.tmp`, JSON.stringify(config, null, 2), { mode: 0o600 })
    await rename(`${filename}.${process.pid}.tmp`, filename)
  }
  await writeFile(marker, JSON.stringify(report, null, 2), { mode: 0o600 })
  return { config, report }
}

export function mergeConfig(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(overlay)])].map((key) => {
    if (!(key in overlay)) return [key, base[key]]
    const previous = base[key]
    const next = overlay[key]
    if (Array.isArray(previous) && Array.isArray(next))
      return [key, [...new Map([...previous, ...next].map((item) => [JSON.stringify(item), item])).values()]]
    const left = Schema.decodeUnknownOption(record)(previous)
    const right = Schema.decodeUnknownOption(record)(next)
    return [key, left._tag === "Some" && right._tag === "Some" ? mergeConfig(left.value, right.value) : next]
  }))
}

function relocateConfig(input: Record<string, unknown>, root: string, skipped: string[]) {
  const config = { ...decode(JSON.parse(JSON.stringify(input).replace(/\{file:([^}]+)\}/g, (_, filename: string) => {
    filename = filename.replaceAll("\\\\", "\\")
    if (path.isAbsolute(filename) || filename.startsWith("~/")) return `{file:${filename.replaceAll("\\", "/")}}`
    return `{file:${path.resolve(root, filename).replaceAll("\\", "/")}}`
  }))) }
  for (const key of ["provider", "providers"]) {
    const value = Schema.decodeUnknownOption(record)(config[key])
    if (value._tag === "Some") config[key] = Object.fromEntries(Object.entries(value.value).filter(([id]) => id !== "antigravity"))
  }
  const plugins = [
    ...Schema.decodeUnknownSync(Schema.Array(Schema.Union([
      Schema.String, Schema.Tuple([Schema.String, record]),
    ])))(config.plugin ?? []).map((plugin) => typeof plugin === "string" ? plugin : { package: plugin[0], options: plugin[1] }),
    ...Schema.decodeUnknownSync(Schema.Array(Schema.Union([
      Schema.String, Schema.Struct({ package: Schema.String, options: Schema.optional(record) }),
    ])))(config.plugins ?? []),
  ].flatMap((plugin) => {
    const spec = typeof plugin === "string" ? plugin : plugin.package
    if (isAntigravity(spec)) { skipped.push(spec); return [] }
    const target = spec.startsWith("./") || spec.startsWith("../") ? pathToFileURL(path.resolve(root, spec)).href : spec
    if ((target.startsWith("file:") || path.isAbsolute(target)) && /\.(js|ts|mjs|cjs)$/i.test(target.startsWith("file:") ? fileURLToPath(target) : target)) {
      skipped.push(spec)
      return []
    }
    return [typeof plugin === "string" ? target : { ...plugin, package: target }]
  })
  delete config.plugin
  config.plugins = plugins
  return config
}

function isAntigravity(spec: string) {
  return /(?:^|[/\\])antigravity-plugin\/?$|(?:^|[/\\])opencode-(?:google-)?antigravity-auth(?:@|$)/i.test(spec)
}

async function detectDesktop() {
  if (process.platform !== "win32") return []
  return (await Promise.all(["HKCU", "HKLM"].map(async (hive) => {
    const result = await exec("reg.exe", ["query", `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, "/s", "/f", "OpenCode", "/d"], { windowsHide: true, timeout: 5000 }).catch(() => undefined)
    return (result?.stdout ?? "").split(/\r?\n/).filter((line) => /DisplayName\s+REG_SZ\s+OpenCode(?:\s|$)/i.test(line) && !/Antigravity/i.test(line)).map((line) => line.trim().replace(/^DisplayName\s+REG_SZ\s+/i, ""))
  }))).flat()
}
