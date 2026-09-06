import { findContainer, execInContainer, inspectContainer, getLogs } from "../docker/docker-client.js";
import { getCatalogEntry } from "../config/service-catalog.js";
import { HEALTH_POLL_INTERVAL_MS, STARTUP_TIMEOUT_MS } from "../types/constants.js";
import { appError, ErrorCodes } from "../utils/errors.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkOnce(containerId, catalogEntry) {
  const { healthcheck, port } = catalogEntry;

  switch (healthcheck.type) {
    case "http": {
      // 127.0.0.1 (not "localhost") avoids IPv6 resolution ending up at a connection refused
      // when the target process only binds an IPv4 listener.
      const url = `http://127.0.0.1:${port}${healthcheck.path || "/"}`;
      const { exitCode } = await execInContainer(containerId, ["wget", "-q", "-T", "3", "-O", "/dev/null", url]);
      return exitCode === 0;
    }
    case "tcp": {
      // try busybox nc first (alpine-based images), fall back to bash's /dev/tcp (debian-based, e.g. redis:7)
      const viaNc = await execInContainer(containerId, ["nc", "-z", "-w", "3", "127.0.0.1", String(port)]).catch(
        () => ({ exitCode: 1 })
      );
      if (viaNc.exitCode === 0) return true;
      const viaBash = await execInContainer(containerId, ["bash", "-c", `echo > /dev/tcp/127.0.0.1/${port}`]).catch(
        () => ({ exitCode: 1 })
      );
      return viaBash.exitCode === 0;
    }
    case "mysql": {
      const password = process.env.MYSQL_ROOT_PASSWORD || "praxis";
      const { exitCode } = await execInContainer(containerId, [
        "mysqladmin",
        "ping",
        "-h",
        "127.0.0.1",
        "-uroot",
        `-p${password}`,
        "--silent"
      ]);
      return exitCode === 0;
    }
    case "mongodb": {
      const { exitCode } = await execInContainer(containerId, [
        "mongosh",
        "mongodb://127.0.0.1:27017",
        "--quiet",
        "--eval",
        "db.adminCommand('ping')"
      ]);
      return exitCode === 0;
    }
    case "docker": {
      const info = await inspectContainer(containerId);
      return info.State?.Health?.Status === "healthy";
    }
    default:
      return true;
  }
}

// Polls a service's own readiness check (never just container-running state) until healthy or timeout.
// catalogEntry can be passed explicitly for services provisioned dynamically (not in the static SERVICE_CATALOG).
export async function waitForHealthy(
  project,
  serviceName,
  { timeoutMs = STARTUP_TIMEOUT_MS, intervalMs = HEALTH_POLL_INTERVAL_MS, catalogEntry } = {}
) {
  catalogEntry ||= getCatalogEntry(serviceName);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const container = await findContainer(project, serviceName);
    if (container && container.State === "running") {
      try {
        if (await checkOnce(container.Id, catalogEntry)) return true;
      } catch {
        // container may still be booting (no listener/shell yet); keep polling
      }
    }
    await sleep(intervalMs);
  }

  const container = await findContainer(project, serviceName);
  const logs = container ? await getLogs(container.Id, { tail: 200 }).catch(() => "") : "";
  throw appError(ErrorCodes.SERVICE_START_TIMEOUT, `${serviceName} did not become healthy within ${timeoutMs}ms`, {
    service: serviceName,
    logs,
    hint: "Inspect logs above (or GET .../services/:service/logs) for the startup failure; the image/command/healthcheck path may be misconfigured, or the service needs more startup time."
  });
}
