/**
 * Server launcher — spawns the dashboard server as a detached process.
 * The spawned server runs in foreground mode (no subcommand) and writes
 * its own PID file at ~/.pi/dashboard/server.pid.
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rootGlobalOr } from "@blackbelt-technology/pi-dashboard-shared/platform/npm.js";
import {
  type DashboardConfig,
  DEFAULT_SERVER_HEAP,
  HEALTH_CHECK_TIMEOUT_MS,
} from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { HEAP_FLAG_MARKER_ENV, stampHeapFlag } from "@blackbelt-technology/pi-dashboard-shared/heap-flags.js";
import { getDashboardServerLogPath } from "@blackbelt-technology/pi-dashboard-shared/dashboard-paths.js";
import {
  EarlyExitError,
  JitiNotFoundError,
  launchDashboardServer,
  PortConflictError,
} from "@blackbelt-technology/pi-dashboard-shared/server-launcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export interface LaunchResult {
  success: boolean;
  message: string;
  /**
   * PID of the spawned child process when `success === true`. Surfaces
   * `launchDashboardServer`'s underlying `childPid` so callers (e.g. the
   * bridge) can register self-spawned PIDs into their exclusion set
   * synchronously after launch. See change: tighten-process-list-ux.
   */
  childPid?: number;
  /**
   * Whether the spawn reached the log-owning path (i.e. `launchDashboardServer`
   * opened `~/.pi/dashboard/server.log` before failing). `false` only for
   * failures that abort BEFORE the log fd is opened (currently just
   * `JitiNotFoundError` — loader resolution precedes log creation). Callers use
   * this to avoid pointing users at a `server.log` that was never written.
   * See change: fix-bridge-server-start-diagnostics (CodeRabbit #3).
   */
  logOwned?: boolean;
}

const SERVER_PKG_SEGMENTS = ["@blackbelt-technology", "pi-dashboard-server", "src", "cli.ts"] as const;

export interface ServerCli {
  cliPath: string;
  /** Node binary that must run this server (desktop install ships its own). */
  nodeBin?: string;
  source: "package" | "monorepo" | "npm-global" | "electron";
}

export interface FindServerCliDeps {
  /** Directory of this module (default: `packages/extension/src`). */
  moduleDir?: string;
  /** Resolve `pi-dashboard-server/package.json`; null when not resolvable. */
  resolvePackage?: () => string | null;
  /** `npm root -g`; "" when npm is unavailable. */
  npmRootGlobal?: () => string;
  exists?: (p: string) => boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
}

/** Default `resources` dirs of the PI Dashboard desktop app (electron-builder). */
function electronResourceDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  if (platform === "win32") {
    const local = env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local");
    return [path.join(local, "Programs", "pi-dashboard", "resources")];
  }
  if (platform === "darwin") {
    return ["/Applications", path.join(home, "Applications")]
      .map((d) => path.join(d, "PI Dashboard.app", "Contents", "Resources"));
  }
  return [path.join("/opt", "PI Dashboard", "resources")];
}

/**
 * Locate an installed dashboard server CLI. Returns the first candidate that
 * exists on disk, or null:
 *   1. `pi-dashboard-server` resolvable from the extension (umbrella / npm -g pi-dashboard)
 *   2. Monorepo dev: `<repo>/packages/server/src/cli.ts`
 *   3. Global npm: `<npm root -g>/@blackbelt-technology/pi-dashboard-server/src/cli.ts`
 *   4. PI Dashboard desktop app: `<resources>/server/node_modules/…`, run with
 *      its bundled `<resources>/node` (native deps are built for that Node).
 *
 * A bridge installed standalone by pi (`npm:@…/pi-dashboard-extension`) has
 * no server dependency; sibling-path math there yields the nonexistent
 * `@blackbelt-technology/server/src/cli.ts`, so every candidate is
 * existence-checked.
 */
export function findServerCli(deps: FindServerCliDeps = {}): ServerCli | null {
  const exists = deps.exists ?? existsSync;
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const home = deps.homedir ?? os.homedir();
  const resolvePackage = deps.resolvePackage ?? (() => {
    try { return require.resolve("@blackbelt-technology/pi-dashboard-server/package.json"); } catch { return null; }
  });

  const pkgJson = resolvePackage();
  if (pkgJson) {
    const cliPath = path.resolve(path.dirname(pkgJson), "src", "cli.ts");
    if (exists(cliPath)) return { cliPath, source: "package" };
  }

  const moduleDir = deps.moduleDir ?? __dirname;
  if (path.basename(path.resolve(moduleDir, "..", "..")) === "packages") {
    const cliPath = path.resolve(moduleDir, "..", "..", "server", "src", "cli.ts");
    if (exists(cliPath)) return { cliPath, source: "monorepo" };
  }

  const npmRoot = (deps.npmRootGlobal ?? (() => rootGlobalOr("")))();
  if (npmRoot) {
    const cliPath = path.join(npmRoot, ...SERVER_PKG_SEGMENTS);
    if (exists(cliPath)) return { cliPath, source: "npm-global" };
  }

  for (const resources of electronResourceDirs(platform, env, home)) {
    const cliPath = path.join(resources, "server", "node_modules", ...SERVER_PKG_SEGMENTS);
    if (!exists(cliPath)) continue;
    const nodeBin = platform === "win32"
      ? path.join(resources, "node", "node.exe")
      : path.join(resources, "node", "bin", "node");
    return exists(nodeBin) ? { cliPath, nodeBin, source: "electron" } : { cliPath, source: "electron" };
  }

  return null;
}

/**
 * Resolve the dashboard server CLI script path (see `findServerCli`). When no
 * install is found, returns the monorepo-relative path — used only as a
 * stable identity (worktree guard, lock key); `launchServer` never spawns it.
 */
export function resolveServerCliPath(): string {
  return findServerCli()?.cliPath ?? path.resolve(__dirname, "..", "..", "server", "src", "cli.ts");
}

export const SERVER_NOT_FOUND_MESSAGE =
  "Dashboard server not found: the bridge extension is installed without " +
  "@blackbelt-technology/pi-dashboard-server. Start the PI Dashboard app, or " +
  "install the server (npm i -g @blackbelt-technology/pi-dashboard-server).";

/**
 * Default V8 old-space ceiling (MB) for the dashboard server.
 *
 * WAS a hardcoded `8192`. Now config-derived (`serverHeap.maxOldSpaceMb`) with
 * this as the fallback, and the default itself dropped to 1536 — sized to the
 * byte-bounded event store rather than to "a big number". The 8192 ceiling was
 * not headroom: every `FATAL ERROR: Reached heap limit` in the log corpus is
 * the dashboard server, several of them dying AT the 8192 stamp.
 * See change: bound-subagent-event-serialization,
 *             bound-session-heap-and-gc-telemetry (D8, D9).
 */
export const DEFAULT_SERVER_MAX_OLD_SPACE_MB = DEFAULT_SERVER_HEAP.maxOldSpaceMb;

/**
 * Build the NARROW env overrides the bridge passes to the shared launcher.
 *
 * The shared `launchDashboardServer` owns the base env
 * (`ToolResolver.buildSpawnEnv` — PATH prepends + win32 PATH-key
 * normalization); the `server-launch` spec forbids callers passing a full
 * `process.env` copy, which overlaid the raw PATH and silently dropped those
 * prepends (and on win32 left a `Path`/`PATH` pair). So this returns only:
 *   - `DASHBOARD_STARTER=Bridge`
 *   - `NODE_OPTIONS` + heap provenance marker, via `stampHeapFlag` over a
 *     two-key seed of the inherited values (never overrides an operator
 *     pin); an absent result is `undefined` so the overlay deletes it
 *   - `PI_DASHBOARD_ELECTRON` / `PI_DASHBOARD_RESOURCES_PATH` = `undefined`
 *     (Electron launcher-identity markers are parent-scoped — a
 *     bridge-relaunched server is NOT an Electron child; see change:
 *     unify-pi-runtime-identity)
 *
 * See change: fix-windows-path-env-key-casing,
 *             bound-session-heap-and-gc-telemetry (D4).
 */
export function buildBridgeEnvOverrides(
  baseEnv: NodeJS.ProcessEnv = process.env,
  maxOldSpaceMb: number = DEFAULT_SERVER_MAX_OLD_SPACE_MB,
): Record<string, string | undefined> {
  const seed: Record<string, string> = {};
  const inheritedOptions = baseEnv["NODE_OPTIONS"];
  const inheritedMarker = baseEnv[HEAP_FLAG_MARKER_ENV];
  if (inheritedOptions !== undefined) seed["NODE_OPTIONS"] = inheritedOptions;
  if (inheritedMarker !== undefined) seed[HEAP_FLAG_MARKER_ENV] = inheritedMarker;
  const stamped = stampHeapFlag(seed, maxOldSpaceMb);
  return {
    DASHBOARD_STARTER: "Bridge",
    NODE_OPTIONS: stamped["NODE_OPTIONS"],
    [HEAP_FLAG_MARKER_ENV]: stamped[HEAP_FLAG_MARKER_ENV],
    PI_DASHBOARD_ELECTRON: undefined,
    PI_DASHBOARD_RESOURCES_PATH: undefined,
  };
}

/**
 * Build the spawn arguments from config.
 */
export function buildSpawnArgs(config: DashboardConfig): string[] {
  return [
    "--port", String(config.port),
    "--pi-port", String(config.piPort),
  ];
}

/**
 * Launch the dashboard server as a detached background process.
 * Delegates to the shared `launchDashboardServer` primitive which owns
 * loader resolution, argv shape, env merge, log-file policy, and
 * readiness polling (see `packages/shared/src/server-launcher.ts`).
 *
 * Bridge-specific contract: `DASHBOARD_STARTER=Bridge`,
 * `stdio: { logFile: getDashboardServerLogPath() }` (Bridge auto-spawn
 * now owns the shared `~/.pi/dashboard/server.log` so a slow/crashed
 * cold start leaves an inspectable log), and a cold-start health timeout
 * taken from `config.readinessTimeoutMs` (default 10 s; raise on hosts whose
 * cold start — e.g. a large startup session scan — outlives the window.
 * `EarlyExitError` still surfaces a real crash instantly).
 * See change: fix-bridge-server-start-diagnostics,
 * add-configurable-readiness-timeout.
 */
export async function launchServer(
  config: DashboardConfig,
  deps: { findCli?: () => ServerCli | null } = {},
): Promise<LaunchResult> {
  const server = (deps.findCli ?? findServerCli)();
  if (!server) return { success: false, message: SERVER_NOT_FOUND_MESSAGE, logOwned: false };
  const args = buildSpawnArgs(config);

  try {
    const result = await launchDashboardServer({
      cliPath: server.cliPath,
      // Anchor jiti in the server's own tree; desktop installs run on their bundled Node.
      anchor: server.cliPath,
      nodeBin: server.nodeBin,
      extraArgs: args,
      // Narrow overrides only (heap stamp + starter + marker strip). The
      // heap stamp must still ride along: a bridge-auto-started server
      // inherits a STRIPPED environment and would otherwise run at the bare
      // V8 default. See change: bound-session-heap-and-gc-telemetry (D5a),
      // fix-windows-path-env-key-casing (no full process.env copy).
      env: buildBridgeEnvOverrides(process.env, config.serverHeap?.maxOldSpaceMb),
      stdio: { logFile: getDashboardServerLogPath() },
      healthTimeoutMs: config.readinessTimeoutMs ?? HEALTH_CHECK_TIMEOUT_MS,
      port: config.port,
      starter: "Bridge",
    });
    return { success: true, message: "Server started", childPid: result.childPid, logOwned: true };
  } catch (err: unknown) {
    if (err instanceof JitiNotFoundError) {
      // Thrown before the log fd is opened — no server.log exists.
      return { success: false, message: err.message, logOwned: false };
    }
    if (err instanceof PortConflictError) {
      return { success: false, message: err.message, logOwned: true };
    }
    if (err instanceof EarlyExitError) {
      return {
        success: false,
        message: `Server process exited (code=${err.code}) before health check. See ${getDashboardServerLogPath()}`,
        logOwned: true,
      };
    }
    // Readiness timeout (and any other post-spawn error): the log was opened
    // before the readiness loop, so it exists and is worth pointing at.
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, message, logOwned: true };
  }
}
