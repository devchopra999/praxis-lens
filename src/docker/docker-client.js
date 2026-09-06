import Docker from "dockerode";
import { PassThrough } from "node:stream";

// The only module in this codebase allowed to talk to the Docker Engine API directly.
export const docker = new Docker();

// Finds the live container for a compose service by its compose labels (avoids stale container IDs after restarts).
export async function findContainer(project, serviceName) {
  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({
      label: [`com.docker.compose.project=${project}`, `com.docker.compose.service=${serviceName}`]
    })
  });
  return containers[0] || null;
}

export async function inspectContainer(containerId) {
  return docker.getContainer(containerId).inspect();
}

// docker stats' well-known CPU%/mem% formula; a single non-streaming read already contains
// enough of a cpu_stats/precpu_stats delta window to compute a meaningful percentage.
function computeUsage(stats) {
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats?.cpu_usage?.total_usage || 0);
  const systemDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats?.system_cpu_usage || 0);
  const onlineCpus = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;
  const cpuPercent = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * onlineCpus * 100 : 0;

  const cache = stats.memory_stats.stats?.cache ?? stats.memory_stats.stats?.inactive_file ?? 0;
  const memoryUsageBytes = Math.max(0, (stats.memory_stats.usage || 0) - cache);
  const memoryLimitBytes = stats.memory_stats.limit || 0;
  const memoryPercent = memoryLimitBytes > 0 ? (memoryUsageBytes / memoryLimitBytes) * 100 : 0;

  return {
    cpuPercent: Math.round(cpuPercent * 100) / 100,
    memoryUsageBytes,
    memoryLimitBytes,
    memoryPercent: Math.round(memoryPercent * 100) / 100
  };
}

export async function getContainerStats(containerId) {
  const stats = await docker.getContainer(containerId).stats({ stream: false });
  return computeUsage(stats);
}

// Runs argv (never a shell string) inside a running container and captures stdout/stderr separately.
export async function execInContainer(containerId, argv, { timeoutSec } = {}) {
  const container = docker.getContainer(containerId);
  const cmd = timeoutSec ? ["timeout", String(timeoutSec), ...argv] : argv;

  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true, stdin: false });

  const stdoutChunks = [];
  const stderrChunks = [];
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();
  stdoutStream.on("data", (chunk) => stdoutChunks.push(chunk));
  stderrStream.on("data", (chunk) => stderrChunks.push(chunk));
  docker.modem.demuxStream(stream, stdoutStream, stderrStream);

  const startedAt = Date.now();

  await new Promise((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  const { ExitCode } = await exec.inspect();

  return {
    exitCode: ExitCode,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    durationMs: Date.now() - startedAt
  };
}

// Demuxes a non-TTY docker logs buffer into plain text, preserving frame order.
function demuxLogBuffer(buffer) {
  let offset = 0;
  let text = "";
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    text += buffer.subarray(offset + 8, offset + 8 + size).toString("utf8");
    offset += 8 + size;
  }
  return text;
}

export async function getLogs(containerId, { tail = 200, since } = {}) {
  const container = docker.getContainer(containerId);
  const opts = { stdout: true, stderr: true, tail, timestamps: true, follow: false };
  if (since) opts.since = Math.floor(new Date(since).getTime() / 1000);

  const buffer = await container.logs(opts);
  return demuxLogBuffer(buffer);
}
