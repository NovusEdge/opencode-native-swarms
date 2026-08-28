import { createHash } from "node:crypto"
import type { EnvironmentProvider, FilesystemAdapter, RunRecord } from "./types"

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
  if (!repository.commonDirectory || repository.commonDirectory.includes("\0") || !repository.metadata || Object.keys(repository.metadata).length === 0) throw new Error("Repository identity unavailable")
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
    this.root = `${(configured || fallback).replace(/\/$/, "")}/opencode-native-swarms/${this.repositoryKey}`
  }
  private path(runId: string) { if (!runId || /[\\/\0]/.test(runId)) throw new Error("Invalid run ID"); return `${this.root}/${runId}.json` }
  private lockPath() { return `${this.root}/.lock` }
  private async withLock<T>(fn: () => Promise<T>): Promise<T> { const lock = await this.fs.acquireLock(this.lockPath()); try { return await fn() } finally { await lock.release() } }
  private validate(value: unknown): RunRecord {
    if (!value || typeof value !== "object") throw new Error("Corrupt state record")
    const record = value as Record<string, unknown>
    for (const key of ["runId", "workflowName", "workflowHash", "state", "createdAt", "updatedAt", "steps", "policyHash"]) if (typeof record[key] !== "string" && key !== "steps") throw new Error("Incomplete state record")
    if (!Array.isArray(record.steps)) throw new Error("Corrupt state steps")
    return value as RunRecord
  }
  async read(runId: string): Promise<RunRecord | undefined> {
    try { return this.validate(JSON.parse(await this.fs.read(this.path(runId)))) } catch (error) { if (error instanceof Error && /not found|ENOENT/i.test(error.message)) { try { return this.validate(JSON.parse(await this.fs.read(`${this.path(runId)}.complete`))) } catch { return undefined } } throw error }
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
  private async writeUnlocked(runId: string, record: RunRecord): Promise<void> { const data = JSON.stringify(sanitize(record)); const target = this.path(runId), temp = `${target}.tmp-${Date.now()}`; const anyFs = this.fs as any; if (typeof anyFs.writeTemp === "function") await anyFs.writeTemp(temp, data); else await this.fs.atomicWrite(temp, data); if (typeof anyFs.fsync === "function") try { await anyFs.fsync(temp) } catch {} if (typeof anyFs.rename === "function") await anyFs.rename(temp, target); else await this.fs.atomicWrite(target, data); await this.fs.atomicWrite(`${target}.complete`, data) }
  async listRuns(): Promise<readonly RunRecord[]> {
    const fsAny = this.fs as FilesystemAdapter & Record<string, unknown>
    if (typeof fsAny.list !== "function") return []
    const paths = await (fsAny.list as (path: string) => Promise<readonly string[]>)(this.root)
    const runs: RunRecord[] = []
    for (const path of paths) { if (!path.endsWith(".json") || path.endsWith(".tmp.json")) continue; try { const value = JSON.parse(await this.fs.read(path)); if (value && typeof value.runId === "string") runs.push(value) } catch { /* ignore incomplete records */ } }
    return runs.sort((a, b) => a.runId.localeCompare(b.runId))
  }
}

export function repositoryKey(identity: RepositoryIdentity | string): string { return keyFor(identity) }
export function createRepositoryStateStore(options: StateStoreOptions): RepositoryStateStore { return new RepositoryStateStore(options) }
