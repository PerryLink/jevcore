/**
 * Credential resolution.
 *
 * The key is resolved through DSH's credential service first, so it can live in
 * the managed credential store and be edited without touching the environment
 * or this plugin's configuration. An environment variable is the fallback, and
 * is read lazily at call time rather than captured at load, so a key added
 * while the process is running is picked up.
 *
 * The resolved value never leaves this module except as the argument to a
 * provider constructor, and it is never logged, never returned from a tool, and
 * never included in an error message.
 */

/** Minimal shape of the DSH credential service this module uses. */
export interface CredentialResolver {
  resolve(ref: string): Promise<{ readonly value?: string } | undefined>
}

export interface ResolveKeyOptions {
  readonly ref: string
  /** The credential service, when the composition provides one. */
  readonly credentials?: CredentialResolver | undefined
  /** Environment lookup, injectable for tests. */
  readonly env?: (name: string) => string | undefined
}

export type KeySource = 'credential' | 'environment'

export interface ResolvedKey {
  readonly value: string
  readonly source: KeySource
}

/**
 * Resolve an API key, or `undefined` when no source has one.
 *
 * Never throws on a missing key: the caller decides whether that is fatal,
 * which lets the plugin load cleanly with no credential and simply stay
 * offline.
 */
export const resolveApiKey = async (options: ResolveKeyOptions): Promise<ResolvedKey | undefined> => {
  const env = options.env ?? ((name: string) => process.env[name])

  if (options.credentials !== undefined) {
    try {
      const resolved = await options.credentials.resolve(options.ref)
      const value = resolved?.value?.trim()
      if (value !== undefined && value.length > 0) return { value, source: 'credential' }
    } catch {
      // A credential provider that is present but failing must not mask the
      // environment fallback; the caller still gets a chance to work.
    }
  }

  const fromEnv = env(options.ref)?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return { value: fromEnv, source: 'environment' }
  }
  return undefined
}

/** Whether a key exists, without exposing it. */
export const describeKeySource = async (options: ResolveKeyOptions): Promise<KeySource | 'none'> => {
  const resolved = await resolveApiKey(options)
  return resolved?.source ?? 'none'
}
