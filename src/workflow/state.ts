import { createHash } from "node:crypto"
import { transitionWorkflow } from "./planner"
import type { EnvironmentProvider, FilesystemAdapter, RunRecord, StepState, WorkflowState } from "./types"

export type RepositoryIdentity = Readonly<{ commonDirectory: string; metadata?: Readonly<Record<string, unknown>> }>
export type StateStoreOptions = Readonly<{ filesystem: FilesystemAdapter; environment: EnvironmentProvider; repository: RepositoryIdentity; stateRoot?: never }>
export type StateEvent = Readonly<{ type: string; at?: string; details?: unknown }>

const secretKey = /(pass(word)?|secret|token|api[_-]?key|credential|authorization|cookie|private[_-]?key)/i
const transcriptKey = /(transcript|messages|conversation|raw(input|output)?)/i
function sanitize(value: unknown, key = ""): unknown {
  if (secretKey.test(key) || transcriptKey.test(key)) return "[REDACTED]"
  if (/^(env|environment|environ)$/i.test(key)) return "[REDACTED]"
  if (Array.isArray(value)) return value.map((item) => sanitize(item, key))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [name, item] of Object.entries(value as Record<string, unknown>)) out[name] = sanitize(item, name)
    return out
  }
  return value
}
function keyFor(repository: RepositoryIdentity | string): string {
  if (typeof repository === "string") throw new Error("Canonical repository identity with metadata is required")
  if (!repository.commonDirectory.startsWith("/") || repository.commonDirectory.includes("..") || repository.commonDirectory.includes("\\") || repository.commonDirectory.includes("\0") || !repository.metadata || Object.keys(repository.metadata).length === 0) throw new Error("Repository identity unavailable")
  const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v)
  return createHash("sha256").update(canonical(repository)).digest("hex")
}

export function redactEvidence<T>(value: T): T { return sanitize(value) as T }

export class RepositoryStateStore {
  readonly repositoryKey: string
  readonly root: string
  private readonly fs: FilesystemAdapter
  private readonly env: EnvironmentProvider
  private readonly repository: RepositoryIdentity | string
  constructor(options: StateStoreOptions) {
    this.fs = options.filesystem; this.env = options.environment; this.repository = options.repository
    this.repositoryKey = keyFor(options.repository)
    if ((options as any).stateRoot !== undefined) throw new Error("stateRoot override is not permitted")
    const configured = this.env.get("XDG_STATE_HOME")
    const fallback = `${this.env.homeDirectory()}/.local/state`
    if (!configured && !this.env.homeDirectory()) throw new Error("State directory unavailable")
    const stateBase = configured || fallback
    if (!stateBase.startsWith("/") || stateBase.includes("..") || stateBase.includes("\\") || stateBase.includes("\0")) throw new Error("Invalid XDG state directory")
    this.root = `${stateBase.replace(/\/$/, "")}/opencode-native-swarms/${this.repositoryKey}`
  }
  private path(runId: string) { if (!runId || /[\\/\0]/.test(runId)) throw new Error("Invalid run ID"); return `${this.root}/${runId}.json` }
  private lockPath() { return `${this.root}/.lock` }
  private async withLock<T>(fn: () => Promise<T>): Promise<T> { const lock = await this.fs.acquireLock(this.lockPath()); try { return await fn() } finally { await lock.release() } }
  private validate(value: unknown): RunRecord {
    if (!value || typeof value !== "object") throw new Error("Corrupt state record")
    const record = value as Record<string, unknown>
    for (const key of ["runId", "workflowName", "workflowHash", "state", "createdAt", "updatedAt", "policyHash"]) if (typeof record[key] !== "string") throw new Error("Incomplete state record")
    if (!/^[0-9a-f]{64}$/.test(record.workflowHash as string) || !/^[0-9a-f]{64}$/.test(record.policyHash as string) || !Number.isInteger(record.revision) || (record.revision as number) < 1) throw new Error("Invalid state hashes or revision")
    if (!/^\d{4}-\d\d-\d\dT/.test(record.createdAt as string) || !/^\d{4}-\d\d-\d\dT/.test(record.updatedAt as string)) throw new Error("Invalid state timestamps")
    if (!( ["draft", "awaiting-approval", "running", "succeeded", "failed", "cancelled", "stale"] as readonly string[]).includes(record.state as string)) throw new Error("Invalid workflow state")
    if (!Array.isArray(record.steps)) throw new Error("Corrupt state steps")
    for (const step of record.steps) { if (!step || typeof step !== "object" || typeof (step as any).id !== "string" || !(["queued", "ready", "running", "succeeded", "failed", "cancelled", "skipped"] as readonly string[]).includes((step as any).state)) throw new Error("Corrupt step record") }
    return value as RunRecord
  }
  async read(runId: string): Promise<RunRecord | undefined> {
    let primary: string | undefined
    try { primary = await this.fs.read(this.path(runId)); return this.validate(JSON.parse(primary)) } catch (error) {
      try { return this.validate(JSON.parse(await this.fs.read(`${this.path(runId)}.complete`))) } catch (backupError) {
        const missing = (e: unknown) => e instanceof Error && /not found|ENOENT/i.test(e.message)
        if (missing(error) && missing(backupError)) return undefined
        throw new Error("Corrupt state: primary and last-complete records are unavailable")
      }
    }
  }
  async write(runId: string, record: RunRecord): Promise<void> {
    await this.withLock(async () => {
      const data = JSON.stringify(sanitize(record))
      const target = this.path(runId), temp = `${target}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`
      const fsAny = this.fs as FilesystemAdapter & Record<string, unknown>
      if (typeof fsAny.writeTemp === "function") await (fsAny.writeTemp as (path: string, data: string) => Promise<void>)(temp, data)
      else await this.fs.atomicWrite(temp, data)
      if (typeof fsAny.fsync === "function") { try { await (fsAny.fsync as (path: string) => Promise<void>)(temp) } catch { /* fsync is best effort */ } }
      if (typeof fsAny.rename === "function") await (fsAny.rename as (from: string, to: string) => Promise<void>)(temp, target)
      else await this.fs.atomicWrite(target, data)
      await this.fs.atomicWrite(`${target}.complete`, data)
    })
  }
  async appendEvent(runId: string, event: StateEvent): Promise<RunRecord | undefined> {
    return this.withLock(async () => { const current = await this.read(runId); if (!current) return undefined; if (!event?.type) throw new Error("Invalid state event"); const events = [...(((current as any).events ?? []) as unknown[]), sanitize(event)]; const next = { ...current, events, updatedAt: new Date().toISOString() } as RunRecord; await this.writeUnlocked(runId, next); return next })
  }
  async transition(runId: string, next: WorkflowState, expected?: Readonly<{ repositoryId?: string; workspaceId?: string; revision?: number; policyHash?: string }>): Promise<RunRecord | undefined> {
    return this.withLock(async () => { const current = await this.read(runId); if (!current) return undefined; this.checkExpected(current, expected); transitionWorkflow(current.state, next); const updated = { ...current, state: next, events: [...(((current as any).events ?? []) as unknown[]), { type: "workflow-transition", from: current.state, to: next, at: new Date().toISOString() }], updatedAt: new Date().toISOString() } as RunRecord; await this.writeUnlocked(runId, updated); return updated })
  }
  async transitionStep(runId: string, stepId: string, next: StepState, expected?: Readonly<{ revision?: number; policyHash?: string; repositoryId?: string; workspaceId?: string }>): Promise<RunRecord | undefined> { return this.withLock(async () => { const current = await this.read(runId); if (!current) return undefined; this.checkExpected(current, expected); if (!current.steps.some((step) => step.id === stepId)) throw new Error("Unknown step ID"); const steps = current.steps.map((step) => step.id === stepId ? { ...step, state: this.legalStep(step.state, next) } : step); const updated = { ...current, steps, events: [...(((current as any).events ?? []) as unknown[]), { type: "step-transition", stepId, next, at: new Date().toISOString() }], updatedAt: new Date().toISOString() } as RunRecord; await this.writeUnlocked(runId, updated); return updated }) }
  async resume(runId: string, expected: Readonly<{ revision: number; policyHash: string; repositoryId?: string; workspaceId?: string }>): Promise<RunRecord> { return this.withLock(async () => { const current = await this.read(runId); if (!current) throw new Error("Run absent"); this.checkExpected(current, expected); if (current.state === "stale") throw new Error("Stale run requires an amendment/new revision"); if (current.state !== "running" && current.state !== "failed") throw new Error("Run is not resumable"); const updated = { ...current, events: [...(((current as any).events ?? []) as unknown[]), { type: "resume-approved", at: new Date().toISOString() }], updatedAt: new Date().toISOString() } as RunRecord; await this.writeUnlocked(runId, updated); return updated }) }
  private legalStep(current: string, next: StepState): StepState { const legal: Record<string, readonly string[]> = { queued: ["ready", "skipped"], ready: ["running", "cancelled"], running: ["succeeded", "failed", "cancelled"] }; if (!legal[current]?.includes(next)) throw new Error(`Illegal step transition: ${current} -> ${next}`); return next }
  private checkExpected(record: RunRecord, expected?: Readonly<{ repositoryId?: string; workspaceId?: string; revision?: number; policyHash?: string }>) { if (expected?.revision !== undefined && expected.revision !== record.revision || expected?.policyHash !== undefined && expected.policyHash !== record.policyHash || expected?.repositoryId !== undefined && (record.repository?.id !== expected.repositoryId) || expected?.workspaceId !== undefined && (record.repository?.directory !== expected.workspaceId)) throw new Error("State drift detected") }
  async revalidate(runId: string, current: Readonly<{ repositoryId?: string; workspaceId?: string; revision?: number; policyHash?: string }>): Promise<Readonly<{ stale: boolean; record?: RunRecord }>> {
    return this.withLock(async () => { const record = await this.read(runId); if (!record) return { stale: true }; const stale = (current.revision !== undefined && current.revision !== record.revision) || (current.policyHash !== undefined && current.policyHash !== record.policyHash) || (current.repositoryId !== undefined && (record as any).repository?.id !== current.repositoryId) || (current.workspaceId !== undefined && (record as any).repository?.directory !== current.workspaceId); if (!stale) return { stale, record }; if (["succeeded", "cancelled", "stale"].includes(record.state)) throw new Error("Terminal run cannot become stale"); transitionWorkflow(record.state, "stale"); const updated = { ...record, state: "stale", events: [...(((record as any).events ?? []) as unknown[]), { type: "stale", reason: "revalidation-drift", at: new Date().toISOString() }], updatedAt: new Date().toISOString() } as RunRecord; await this.writeUnlocked(runId, updated); return { stale: true, record: updated } })
  }
  private async writeUnlocked(runId: string, record: RunRecord): Promise<void> { const data = JSON.stringify(sanitize(record)); const target = this.path(runId), temp = `${target}.tmp-${Date.now()}`; const anyFs = this.fs as any; if (typeof anyFs.writeTemp === "function") await anyFs.writeTemp(temp, data); else await this.fs.atomicWrite(temp, data); if (typeof anyFs.fsync === "function") try { await anyFs.fsync(temp) } catch {} if (typeof anyFs.rename === "function") await anyFs.rename(temp, target); else await this.fs.atomicWrite(target, data); await this.fs.atomicWrite(`${target}.complete`, data) }
  async listRuns(): Promise<readonly RunRecord[]> {
    const fsAny = this.fs as FilesystemAdapter & Record<string, unknown>
    if (typeof fsAny.list !== "function") return []
    const paths = await (fsAny.list as (path: string) => Promise<readonly string[]>)(this.root)
    const runs: RunRecord[] = []
    for (const path of paths) { if (!path.endsWith(".json") || path.endsWith(".tmp.json") || path.endsWith(".complete")) continue; try { runs.push(this.validate(JSON.parse(await this.fs.read(path)))) } catch { /* corrupt records are not surfaced */ } }
    return runs.sort((a, b) => a.runId.localeCompare(b.runId))
  }
}

export function repositoryKey(identity: RepositoryIdentity | string): string { return keyFor(identity) }
export function createRepositoryStateStore(options: StateStoreOptions): RepositoryStateStore { return new RepositoryStateStore(options) }
