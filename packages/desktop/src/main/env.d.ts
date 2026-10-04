interface ImportMetaEnv {
  readonly OPENCODE_CHANNEL: string
  readonly OPENCODE_VERSION?: string
  readonly OPENCODE_ANTIGRAVITY_BUILD?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
