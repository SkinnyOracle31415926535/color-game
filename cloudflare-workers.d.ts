// The deployed Sites runtime provides this virtual module.  Keep the local
// type-checker independent of a runtime-specific ambient package.
declare module "cloudflare:workers" {
  export const env: { DB?: unknown };
}
