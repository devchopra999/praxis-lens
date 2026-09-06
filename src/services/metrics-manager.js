import { docker, findContainer, getContainerStats } from "../docker/docker-client.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Discovers services currently running in an environment straight from Docker (compose labels),
// so metrics reflect live state rather than this service's own possibly-stale DB rows.
export async function listRunningServices(project) {
  const containers = await docker.listContainers({
    filters: JSON.stringify({ label: [`com.docker.compose.project=${project}`] })
  });
  return containers.map((c) => c.Labels["com.docker.compose.service"]).filter(Boolean);
}

async function sampleOnce(project, serviceName) {
  const container = await findContainer(project, serviceName);
  if (!container || container.State !== "running") {
    return { service: serviceName, error: "service is not running" };
  }
  try {
    const usage = await getContainerStats(container.Id);
    return { service: serviceName, ...usage };
  } catch (err) {
    return { service: serviceName, error: String(err.message || err) };
  }
}

// Captures one or more docker-stats samples per service, `intervalSec` apart, so an agent can
// compare CPU/memory trends across services over the same time window in a single response
// (e.g. "EDI CPU climbed to 98% while MySQL stayed under 40%" -> EDI is the bottleneck).
export async function captureMetrics(project, serviceNames, { durationSec = 0, intervalSec = 2 } = {}) {
  const steps = durationSec > 0 ? Math.floor(durationSec / intervalSec) + 1 : 1;
  const series = Object.fromEntries(serviceNames.map((name) => [name, []]));

  for (let step = 0; step < steps; step++) {
    const elapsedSec = step * intervalSec;
    const timestamp = new Date().toISOString();
    const samples = await Promise.all(serviceNames.map((name) => sampleOnce(project, name)));
    for (const { service, ...rest } of samples) {
      series[service].push({ elapsedSec, timestamp, ...rest });
    }
    if (step < steps - 1) await sleep(intervalSec * 1000);
  }

  return series;
}
