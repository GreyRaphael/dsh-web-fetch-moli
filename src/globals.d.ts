/**
 * Build-time constants injected by tsdown `define`.
 *
 * In production builds tsdown replaces these identifiers with string literals.
 * In dev/test the identifiers remain undefined (guarded by `typeof` checks).
 */
declare const __PLUGIN_VERSION__: string
