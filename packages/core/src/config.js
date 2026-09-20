/**
 * Plugin configuration and its validation.
 *
 * Hand-written rather than schema-library-driven on purpose: this package's
 * core must stay dependency-free so its tests run with nothing installed, and
 * the config surface is small enough that an explicit validator is clearer
 * than a schema plus its inference.
 *
 * The defaults are the security posture, not an afterthought. Out of the box
 * this plugin resolves no credential, opens no socket, and reads no tool
 * result:
 *
 *   provider            'mock'      — nothing to reach
 *   gates.safety        false       — does not judge tool calls
 *   gates.context       false       — does not read tool results
 *   defaultModel        'jev-latest'
 *   maxConfidenceFloor  0.7         — an unsure Jev produces `ask`, not `allow`
 */
export const DEFAULT_CONFIG = {
    provider: 'mock',
    apiKeyRef: 'TYPESAFE_API_KEY',
    baseURL: undefined,
    model: 'jev-latest',
    logLevel: 'warn',
    minConfidence: 0.7,
    minProbability: 0.6,
    maxStateChars: undefined,
    gates: {
        safety: { enabled: false, onUndecided: 'ask' },
        context: { enabled: false, onUndecided: 'ask' },
    },
};
export class ConfigError extends Error {
    name = 'ConfigError';
}
/**
 * Fail config validation.
 *
 * Declared as a function rather than an arrow so TypeScript treats calls as
 * unreachable-returning, which lets the readers below narrow instead of
 * carrying `unknown` past their guards.
 */
function fail(message) {
    throw new ConfigError(`dsh-jev config: ${message}`);
}
const readFraction = (name, value, fallback) => {
    if (value === undefined)
        return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        return fail(`"${name}" must be a number between 0 and 1, got ${String(value)}`);
    }
    return value;
};
const readBoolean = (name, value, fallback) => {
    if (value === undefined)
        return fallback;
    if (typeof value !== 'boolean')
        return fail(`"${name}" must be a boolean, got ${String(value)}`);
    return value;
};
const readProvider = (value) => {
    if (value === undefined)
        return DEFAULT_CONFIG.provider;
    if (value === 'mock' || value === 'live')
        return value;
    return fail(`"provider" must be "mock" or "live", got ${String(value)}`);
};
const readGate = (name, value, fallback) => {
    if (value === undefined)
        return fallback;
    // A bare boolean is accepted as shorthand for `{ enabled: <bool> }`, which
    // is how a patch file most naturally turns a gate on or off.
    if (typeof value === 'boolean')
        return { ...fallback, enabled: value };
    if (typeof value !== 'object' || value === null) {
        return fail(`"gates.${name}" must be an object or a boolean`);
    }
    const record = value;
    const onUndecided = record.onUndecided;
    if (onUndecided !== undefined &&
        onUndecided !== 'ask' &&
        onUndecided !== 'allow' &&
        onUndecided !== 'deny') {
        return fail(`"gates.${name}.onUndecided" must be "ask", "allow", or "deny"`);
    }
    return {
        enabled: readBoolean(`gates.${name}.enabled`, record.enabled, fallback.enabled),
        onUndecided: onUndecided ?? fallback.onUndecided,
    };
};
const readLogLevel = (value) => {
    if (value === undefined)
        return DEFAULT_CONFIG.logLevel;
    if (value === 'silent' || value === 'warn' || value === 'info' || value === 'debug')
        return value;
    return fail(`"logLevel" must be silent, warn, info, or debug, got ${String(value)}`);
};
const readMaxStateChars = (value) => {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        return fail('"maxStateChars" must be a non-negative integer');
    }
    // 0 means "use the feature default", which is represented as undefined.
    return value === 0 ? undefined : value;
};
/** Validate and resolve a raw config object. Throws {@link ConfigError}. */
export const resolveConfig = (input) => {
    if (input === undefined)
        return DEFAULT_CONFIG;
    if (typeof input !== 'object' || input === null)
        return fail('configuration must be an object');
    const raw = input;
    const gatesRaw = (raw.gates ?? {});
    return {
        provider: readProvider(raw.provider),
        apiKeyRef: typeof raw.apiKeyRef === 'string' && raw.apiKeyRef.trim().length > 0
            ? raw.apiKeyRef.trim()
            : DEFAULT_CONFIG.apiKeyRef,
        baseURL: typeof raw.baseURL === 'string' && raw.baseURL.trim().length > 0 ? raw.baseURL.trim() : undefined,
        model: typeof raw.model === 'string' && raw.model.trim().length > 0
            ? raw.model.trim()
            : DEFAULT_CONFIG.model,
        logLevel: readLogLevel(raw.logLevel),
        minConfidence: readFraction('minConfidence', raw.minConfidence, DEFAULT_CONFIG.minConfidence),
        minProbability: readFraction('minProbability', raw.minProbability, DEFAULT_CONFIG.minProbability),
        maxStateChars: readMaxStateChars(raw.maxStateChars),
        gates: {
            safety: readGate('safety', gatesRaw.safety, DEFAULT_CONFIG.gates.safety),
            context: readGate('context', gatesRaw.context, DEFAULT_CONFIG.gates.context),
        },
    };
};
//# sourceMappingURL=config.js.map