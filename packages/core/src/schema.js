/**
 * The plugin's configuration schema, expressed as a Standard Schema.
 *
 * Cordis treats a plugin's `Config` export as a Standard Schema and calls
 * `Config['~standard'].validate(config)` before the plugin starts
 * (`vendor/cordis/src/fiber.ts:53`). That makes this export load-bearing, not
 * decorative: a plugin exporting documentation, or anything else without a
 * `~standard.validate`, fails activation with
 * `Cannot read properties of undefined (reading 'validate')`.
 *
 * Implementing the protocol here rather than adding a schema dependency keeps
 * this package's dependency count at zero for its own code, and lets the same
 * `resolveConfig` that the plugin uses at runtime be the thing the Loader
 * validates with — so the two can never disagree.
 */
import { ConfigError, resolveConfig } from './config.js';
/**
 * Validate one config object, converting a thrown {@link ConfigError} into the
 * issues list the protocol expects.
 */
export const validateConfig = (value) => {
    try {
        return { value: resolveConfig(value) };
    }
    catch (error) {
        const message = error instanceof ConfigError ? error.message : String(error);
        return { issues: [{ message }] };
    }
};
/**
 * The schema handed to Cordis.
 *
 * `types` is a type-level annotation only and carries no runtime weight.
 */
export const Config = {
    '~standard': {
        version: 1,
        vendor: 'dsh-jev',
        validate: validateConfig,
        types: undefined,
    },
};
//# sourceMappingURL=schema.js.map