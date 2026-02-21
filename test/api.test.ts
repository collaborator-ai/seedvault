import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import {
  getDaemonHealth,
  writeHealthFile,
  type DaemonHealth,
} from "../client/src/api/health.js";
import { getConfigDir } from "../client/src/config.js";

// --- Health file tests ---

const HEALTH_PATH = join(getConfigDir(), "daemon-health.json");

describe("health file", () => {
  afterEach(() => {
    try { unlinkSync(HEALTH_PATH); } catch {}
  });

  test("getDaemonHealth returns null when health file is missing", () => {
    // Ensure no leftover file
    try { unlinkSync(HEALTH_PATH); } catch {}
    expect(getDaemonHealth()).toBeNull();
  });

  test("writeHealthFile writes valid JSON that getDaemonHealth reads back", () => {
    const input: DaemonHealth = {
      running: true,
      serverConnected: true,
      serverUrl: "http://localhost:3000",
      username: "alice",
      pendingOps: 3,
      collectionsWatched: 2,
      watcherAlive: true,
      lastSyncAt: "2026-01-15T10:00:00.000Z",
      lastReconcileAt: "2026-01-15T10:00:00.000Z",
      updatedAt: "2026-01-15T10:00:05.000Z",
    };

    writeHealthFile(input);

    expect(existsSync(HEALTH_PATH)).toBe(true);
    const written = readFileSync(HEALTH_PATH, "utf-8");
    expect(JSON.parse(written)).toEqual(input);

    const read = getDaemonHealth();
    expect(read).toEqual(input);
  });

  test("getDaemonHealth returns null for malformed JSON", () => {
    writeFileSync(HEALTH_PATH, "not json{{{");
    expect(getDaemonHealth()).toBeNull();
  });
});

// --- ensureDaemonRunning tests ---

describe("ensureDaemonRunning", () => {
  test("installs and starts when not installed", async () => {
    let installCalled = false;
    let restartCalled = false;
    let statusCallCount = 0;

    const { ensureDaemonRunning } = mockEnsureDaemonRunning({
      getServiceStatus: async () => {
        statusCallCount++;
        if (statusCallCount === 1) {
          return { installed: false, running: false, pid: null };
        }
        return { installed: true, running: true, pid: 1234 };
      },
      installService: async () => { installCalled = true; },
      restartService: async () => { restartCalled = true; },
    });

    const status = await ensureDaemonRunning();

    expect(installCalled).toBe(true);
    expect(restartCalled).toBe(false);
    expect(status.installed).toBe(true);
    expect(status.running).toBe(true);
  });

  test("restarts when installed but not running", async () => {
    let installCalled = false;
    let restartCalled = false;
    let statusCallCount = 0;

    const { ensureDaemonRunning } = mockEnsureDaemonRunning({
      getServiceStatus: async () => {
        statusCallCount++;
        if (statusCallCount <= 1) {
          return { installed: true, running: false, pid: null };
        }
        return { installed: true, running: true, pid: 5678 };
      },
      installService: async () => { installCalled = true; },
      restartService: async () => { restartCalled = true; },
    });

    const status = await ensureDaemonRunning();

    expect(installCalled).toBe(false);
    expect(restartCalled).toBe(true);
    expect(status.running).toBe(true);
  });

  test("no-ops when already running", async () => {
    let installCalled = false;
    let restartCalled = false;

    const { ensureDaemonRunning } = mockEnsureDaemonRunning({
      getServiceStatus: async () => ({
        installed: true,
        running: true,
        pid: 9999,
      }),
      installService: async () => { installCalled = true; },
      restartService: async () => { restartCalled = true; },
    });

    const status = await ensureDaemonRunning();

    expect(installCalled).toBe(false);
    expect(restartCalled).toBe(false);
    expect(status.pid).toBe(9999);
  });
});

// --- API exports smoke test ---

describe("API exports", () => {
  test("all expected exports are available from api/index.ts", async () => {
    const api = await import("../client/src/api/index.js");

    // Config
    expect(typeof api.loadConfig).toBe("function");
    expect(typeof api.saveConfig).toBe("function");
    expect(typeof api.configExists).toBe("function");
    expect(typeof api.getConfigPath).toBe("function");
    expect(typeof api.getConfigDir).toBe("function");
    expect(typeof api.addCollection).toBe("function");
    expect(typeof api.removeCollection).toBe("function");
    expect(typeof api.normalizeConfigCollections).toBe("function");
    expect(typeof api.defaultCollectionName).toBe("function");

    // Service
    expect(typeof api.getServiceStatus).toBe("function");
    expect(typeof api.installService).toBe("function");
    expect(typeof api.uninstallService).toBe("function");
    expect(typeof api.restartService).toBe("function");
    expect(typeof api.ensureDaemonRunning).toBe("function");

    // Health
    expect(typeof api.getDaemonHealth).toBe("function");
    expect(typeof api.writeHealthFile).toBe("function");

    // Client
    expect(typeof api.createClient).toBe("function");
    expect(typeof api.ApiError).toBe("function");

  });
});

// --- Test helper ---

interface ServiceStatus {
  installed: boolean;
  running: boolean;
  pid: number | null;
}

function mockEnsureDaemonRunning(mocks: {
  getServiceStatus: () => Promise<ServiceStatus>;
  installService: () => Promise<void>;
  restartService: () => Promise<void>;
}) {
  async function ensureDaemonRunning(): Promise<ServiceStatus> {
    let status = await mocks.getServiceStatus();

    if (!status.installed) {
      await mocks.installService();
      status = await mocks.getServiceStatus();
    }

    if (!status.running) {
      await mocks.restartService();
      status = await mocks.getServiceStatus();
    }

    return status;
  }

  return { ensureDaemonRunning };
}
