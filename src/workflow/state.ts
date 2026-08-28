import { createHash } from "node:crypto"
import type { EnvironmentProvider, FilesystemAdapter, RunRecord } from "./types"

export type RepositoryIdentity = Readonly<{ commonDirectory: string; metadata?: Readonly<Record<string, unknown>> }>
export type StateStoreOptions = Readonly<{ filesystem: FilesystemAdapter; environment: EnvironmentProvider; repository: RepositoryIdentity | string; stateRoot?: string }>
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
  const identity = typeof repository === "string" ? { commonDirectory: repository } : repository
  if (!identity.commonDirectory || identity.commonDirectory.includes("\0")) throw new Error("Repository identity unavailable")
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex")
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
    const configured = options.stateRoot ?? this.env.get("XDG_STATE_HOME")
    const fallback = `${this.env.homeDirectory()}/.local/state`
    if (!configured && !this.env.homeDirectory()) throw new Error("State directory unavailable")
    this.root = `${(configured || fallback).replace(/\/$/, "")}/opencode-native-swarms/${this.repositoryKey}`
  }
  private path(runId: string) { if (!runId || /[\\/\0]/.test(runId)) throw new Error("Invalid run ID"); return `${this.root}/${runId}.json` }
  private lockPath() { return `${this.root}/.lock` }
  private async withLock<T>(fn: () => Promise<T>): Promise<T> { const lock = await this.fs.acquireLock(this.lockPath()); try { return await fn() } finally { await lock.release() } }
  async read(runId: string): Promise<RunRecord | undefined> {
    try { return JSON.parse(await this.fs.read(this.path(runId))) as RunRecord } catch (error) { if (error instanceof Error && /not found|ENOENT/i.test(error.message)) return undefined; throw error }
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
    })
  }
  async appendEvent(runId: string, event: StateEvent): Promise<RunRecord | undefined> {
    return this.withLock(async () => { const current = await this.read(runId); if (!current) return undefined; const events = [...(((current as any).events ?? []) as unknown[]), sanitize(event)]; const next = { ...current, events, updatedAt: new Date().toISOString() } as RunRecord; const data = JSON.stringify(sanitize(next)); await this.fs.atomicWrite(this.path(runId), data); return next })
  }
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
