import type Database from 'better-sqlite3';
import type { ActivityLog } from '../../db/activityLog';
import type { DbPaths } from '../../db/paths';
import type { PricingTable } from '../../../shared/models/pricing';
import type { SupervisorRegistry } from '../../engine/supervisorRegistry';
import type { PolicyHoldRegistry } from '../../controlChannel/policyHoldRegistry';
import type { ChatStreamRegistry } from '../../chat/chatStream';
import type { ChatBroadcaster } from '../../chat/chatBroadcaster';
import type { SafeStorageLike } from '../../secrets/secretStore';
import type { Checkpoint } from '../../../shared/models/checkpoint';
import { ipcNotImplemented } from '../../../shared/ipc/envelope';

export interface HandlerContext {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  readonly dbPaths: DbPaths;
  /** Loaded once at startup (`main/index.ts`, same `loadPricingYaml(
   * resolvePricingYamlPath())` call session 2's own comment already named
   * as the real seam) — M6 session 3's `costsHandlers.pricingTable` is
   * its first real reader. Threaded through `ctx` rather than resolved
   * per-call so the handler never touches `app.isPackaged` itself (this
   * repo's own convention, per `resourcePaths.test.ts`, is that
   * `app.isPackaged`-gated code is only exercised through a real packaged
   * exe — resolving the path fresh on every IPC call would make this
   * handler untestable in the plain integration suite for no benefit). */
  readonly pricing: PricingTable;
  /**
   * Electron's `userData` root. M7's packs handlers need it: user packs
   * are copied to `getPacksDir(baseDir)` and memory seeds are written
   * under `getMemoryDir(baseDir)`. Threaded through `ctx` for the same
   * reason `pricing` is — a handler that called `app.getPath` itself
   * would be untestable outside a real Electron process, and the whole
   * handler layer is exercised from plain Node in the integration suite.
   */
  readonly baseDir: string;
  /**
   * The read-only bundled pack root (`resolveBundledPacksDirPath()`),
   * resolved once at startup. Distinct from `getPacksDir(baseDir)`, which
   * is writable — neither is the other.
   */
  readonly bundledPacksDir: string;
  /** The running app's version — §6.7 check 1 compares against it. */
  readonly appVersion: string;
  /**
   * M7 session 2 — how `employees.pause/resumeEmployee/interrupt` reach
   * the live `Supervisor` for the employee named in the request. Optional
   * because the registry only has entries once employees are actually
   * spawned; a handler that finds nothing says so rather than pretending
   * the operation succeeded.
   */
  readonly supervisorRegistry?: SupervisorRegistry | undefined;
  /**
   * M8 — how `checkpoints.answerPermission` reaches the live hold the
   * agent's HTTP request is parked on (§7.10). It must be the SAME
   * instance `ControlChannelServer` holds on; `main/index.ts` constructs
   * one and passes it to both. Optional for the same reason
   * `supervisorRegistry` is — the control channel may not be running in a
   * given test — and a handler that finds none says so rather than
   * reporting an answer that released nothing.
   */
  readonly policyHoldRegistry?: PolicyHoldRegistry | undefined;
  /**
   * M9 — how `chat.stop` reaches the live stream it is being asked to
   * interrupt. It must be the SAME instance the producer of streams holds;
   * `main/index.ts` constructs one. Optional for the same reason the two
   * registries above are, and with the same discipline: a handler that
   * finds none says so rather than reporting that it stopped something.
   */
  readonly chatStreams?: ChatStreamRegistry | undefined;
  /**
   * M9 session 2 — how a message written by `chat.send` (and a `read_at`
   * stamped by `chat.markRead`) reaches open windows. Must be the same
   * instance the stream registry and the message router hold, or two
   * writers would push down two channels and the renderer's per-window
   * sequence would see gaps that are not gaps. Optional for the same
   * reason the registries are: no window, no push, and the row and its
   * event are written either way.
   */
  readonly chatBroadcaster?: ChatBroadcaster | undefined;
  /**
   * M11 S1-5 — the OS encryption `settings.setSecret` stores keys with.
   * Omitted in production, where the secret store imports Electron's own
   * `safeStorage` (DPAPI) lazily; injected by plain-Node tests, which have
   * no Electron — the same seam `secretBroker.ts` and `oneshot.ts` take.
   */
  readonly safeStorage?: SafeStorageLike | (() => Promise<SafeStorageLike>) | undefined;
  /**
   * M11 row S1-15 — how an answered blocking checkpoint wakes the Director
   * (§26.1). The same trigger queue the message router offers to;
   * `main/index.ts` constructs one. Omitted, nothing is woken.
   */
  readonly directorTriggers?: { offerCheckpointAnswered(checkpoint: Checkpoint): void } | undefined;
}

/**
 * Every handler's real signature. Takes `unknown` — already validated by
 * the router against the method's own schema by the time this runs, but
 * stored generically across ~109 methods of very different shapes, so a
 * "real" handler re-derives its precise type with that same schema's own
 * `.parse()` rather than an unchecked cast (see handlers/settings.ts for
 * the pattern). Stub handlers ignore the input entirely.
 */
export type Handler = (input: unknown, ctx: HandlerContext) => unknown | Promise<unknown>;

/** Every method M2 does not implement returns this, consistently, with
 * the milestone that owns it — never fake behavior. */
export function stub(owningMilestone: string): Handler {
  return () => ipcNotImplemented(owningMilestone);
}
