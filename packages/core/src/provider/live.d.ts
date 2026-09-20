/**
 * The live provider: the only file in this plugin that can reach the network.
 *
 * It delegates to the official `@typesafe-ai/sdk` rather than hand-rolling
 * HTTP, so retries, timeouts, error classification, and response parsing are
 * the vendor's problem, not ours. The SDK is loaded lazily so an offline
 * install neither needs it nor fails without it.
 *
 * Two hardening decisions that differ from the ecosystem norm:
 *
 *  - **The ambient environment is not trusted.** The key is passed explicitly
 *    by the caller, which resolves it through DSH's credential service first.
 *    The SDK's own `TYPESAFE_API_KEY` fallback is defeated by passing
 *    `apiKey` for every request, so a stray variable cannot silently enable
 *    transmission.
 *  - **The endpoint is validated.** A `baseURL` that is not `https:` (or a
 *    loopback `http:`) is refused, so a typo cannot ship prompts in cleartext.
 */
import type { JevProvider, JevRequest, JevResult } from '../types.js';
export declare const DEFAULT_ENDPOINT = "https://api.typesafe.ai";
export declare const DEFAULT_MODEL = "jev-latest";
/** The subset of the official SDK this provider uses. */
interface SystemOneClient {
    systemOne(request: {
        state: unknown;
        questions: unknown;
        model?: string;
    }, options?: {
        signal?: AbortSignal;
    }): Promise<unknown>;
}
interface SdkModule {
    TypeSafeClient: new (config: {
        apiKey: string;
        baseURL?: string;
        dangerouslyAllowBrowser?: boolean;
    }) => SystemOneClient;
}
export interface LiveProviderOptions {
    /** Resolved API key. Never sourced from the environment by this class. */
    readonly apiKey: string;
    /** API root. Defaults to {@link DEFAULT_ENDPOINT}. */
    readonly baseURL?: string;
    /** Model name. Defaults to {@link DEFAULT_MODEL}. */
    readonly model?: string;
    /** Injectable for tests, so no test needs a real key or a real socket. */
    readonly loadSdk?: () => Promise<SdkModule>;
}
/** Refuse an endpoint that would send prompts in cleartext. */
export declare const assertUsableEndpoint: (baseURL: string) => string;
/**
 * Load the official SDK.
 *
 * Exported so the "SDK is not installed" path is testable without uninstalling
 * anything: a test can call this with a specifier known to be unresolvable.
 */
export declare const loadOfficialSdk: (specifier?: string) => Promise<SdkModule>;
/** A provider backed by the official TypeSafe SDK. */
export declare class LiveProvider implements JevProvider {
    private readonly options;
    readonly id = "live";
    private readonly baseURL;
    private client;
    constructor(options: LiveProviderOptions);
    /** The endpoint this provider will POST to. Used by the startup report. */
    get endpoint(): string;
    private clientForRequest;
    answer(request: JevRequest, signal?: AbortSignal): Promise<JevResult>;
}
export {};
//# sourceMappingURL=live.d.ts.map