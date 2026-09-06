export async function waitForJob(request, app, jobId, { timeoutMs = 120000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request(app).get(`/jobs/${jobId}`);
    if (["ready", "failed", "timeout"].includes(res.body.status)) return res.body;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`job ${jobId} did not finish within ${timeoutMs}ms`);
}
