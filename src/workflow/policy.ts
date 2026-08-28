import { createHash } from "node:crypto"
import picomatch from "picomatch"
import { CAPABILITIES, type Capability, type EffectivePolicy, type PermissionPolicy, type PolicyDecision } from "./types"

export type PolicyLayer = PermissionPolicy | Readonly<{ permissions: PermissionPolicy; protectedPaths?: readonly string[] }>
export type PolicyLayers = Readonly<{
  installation: PolicyLayer
  launch: PolicyLayer
  workflow: PolicyLayer
  step: PolicyLayer
  protectedPaths?: readonly string[]
}>

type CompiledPolicy = EffectivePolicy & Readonly<{
  protectedPaths: readonly string[]
  layers: readonly [PermissionPolicy, PermissionPolicy, PermissionPolicy, PermissionPolicy]
}>

const layerNames = ["installation", "launch", "workflow", "step"] as const
const defaultProtectedPaths = [".git", ".git/**", "**/.git", "**/.git/**", ".env", ".env.*", "**/.env", "**/.env.*", "*.env", "*.env.*", "**/*.env", "**/*.env.*", "secrets/**", "**/secrets/**"]
const knownCapabilities = new Set<string>(CAPABILITIES)

function uniqueSorted(values: readonly string[]): string[] { return [...new Set(values)].sort() }
function policyOf(layer: PolicyLayer): PermissionPolicy { return "permissions" in layer ? layer.permissions : layer }

function validPath(value: string): boolean {
  if (!value || value !== value.trim() || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return false
  return !value.split("/").some((segment) => segment === "..")
}
function matches(pattern: string, path: string): boolean {
  if (!validPath(pattern) || !pattern.trim() || !validPath(path)) return false
  return picomatch(pattern, { dot: true, nocase: false })(path)
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export function compilePolicy(input: PolicyLayers): CompiledPolicy {
  const source = layerNames.map((name) => policyOf(input[name])) as [PermissionPolicy, PermissionPolicy, PermissionPolicy, PermissionPolicy]
  for (let i = 0; i < source.length; i++) {
    for (const field of ["readPaths", "writePaths"] as const) {
      for (let j = 0; j < source[i][field].length; j++) {
        if (!validPath(source[i][field][j])) throw new Error(`Invalid policy path pattern (${layerNames[i]}.${field}[${j}])`)
      }
    }
  }
  const configuredProtectedPaths = [
    ...(input.protectedPaths ?? []),
    ...layerNames.flatMap((name) => "protectedPaths" in input[name] ? input[name].protectedPaths ?? [] : []),
  ]
  for (let i = 0; i < configuredProtectedPaths.length; i++) {
    if (!validPath(configuredProtectedPaths[i])) throw new Error(`Invalid policy path pattern (protectedPaths[${i}])`)
  }
  const capabilities = source.reduce((set, layer) => {
    const allowed = new Set(layer.capabilities)
    return new Set([...set].filter((capability) => allowed.has(capability)))
  }, new Set<Capability>(CAPABILITIES))
  const deny = uniqueSorted(source.flatMap((layer) => layer.deny)) as Capability[]
  for (const capability of deny) capabilities.delete(capability)
  const protectedPaths = uniqueSorted([
    ...defaultProtectedPaths,
    ...configuredProtectedPaths,
  ])
  const result = {
    capabilities: [...capabilities].sort(), deny, readPaths: uniqueSorted(source[3].readPaths), writePaths: uniqueSorted(source[3].writePaths),
    hash: "", protectedPaths, layers: source,
  } as CompiledPolicy
  return { ...result, hash: effectivePolicyHash(result) } as CompiledPolicy
}

export function decideCapability(policy: EffectivePolicy, capability: string): PolicyDecision {
  const compiled = policy as CompiledPolicy
  if (!knownCapabilities.has(capability)) return { allowed: false, layer: "capability", rule: "unknown-capability", reason: "Unknown capability" }
  for (let i = 0; i < compiled.layers.length; i++) {
    const layer = compiled.layers[i]
    if (layer.deny.includes(capability as Capability)) return { allowed: false, layer: layerNames[i], rule: "deny", reason: "Explicitly denied" }
    if (!layer.capabilities.includes(capability as Capability)) return { allowed: false, layer: layerNames[i], rule: "capabilities", reason: "Capability is not allowed" }
  }
  return { allowed: true }
}

export function decidePath(policy: EffectivePolicy, operation: "read" | "write", path: string): PolicyDecision {
  const compiled = policy as CompiledPolicy
  if (!validPath(path)) return { allowed: false, layer: "path", rule: "repository-root-relative", reason: "Malformed path" }
  for (const protectedPath of compiled.protectedPaths) if (matches(protectedPath, path)) return { allowed: false, layer: "protected", rule: protectedPath, reason: "Protected path" }
  const capability = operation === "read" ? "repo.read" : "workspace.patch"
  const capabilityDecision = decideCapability(policy, capability)
  if (!capabilityDecision.allowed) return capabilityDecision
  const rule = operation === "read" ? "readPaths" : "writePaths"
  for (let i = 0; i < compiled.layers.length; i++) {
    if (!compiled.layers[i][rule].some((pattern) => matches(pattern, path))) return { allowed: false, layer: layerNames[i], rule, reason: "Path is outside allowed scope" }
  }
  return { allowed: true }
}

export function effectivePolicyHash(policy: EffectivePolicy): string {
  const value = policy as CompiledPolicy
  const canonicalPolicy = {
    capabilities: uniqueSorted(value.capabilities), deny: uniqueSorted(value.deny), readPaths: uniqueSorted(value.readPaths),
    writePaths: uniqueSorted(value.writePaths), protectedPaths: uniqueSorted(value.protectedPaths ?? []),
    layers: value.layers?.map((layer) => ({
      capabilities: uniqueSorted(layer.capabilities), deny: uniqueSorted(layer.deny),
      readPaths: uniqueSorted(layer.readPaths), writePaths: uniqueSorted(layer.writePaths),
    })),
  }
  return createHash("sha256").update(canonical(canonicalPolicy)).digest("hex")
}
