// The gate client (programs/cross_gate): instruction builders, decoders, the rules in plain English and the eligibility
// diagnosis. This is a vendored copy of packages/cross-gate-client/src (see ./gate-client/*, written by that package's
// `vendor:web` script and kept current by its test), because the web app's bundler does not map the package's `.js` import
// specifiers to TypeScript and the app does not list the package as a dependency. Everything below imports from here, so
// switching to the package name is a one-line change.
export * from './gate-client/index';
