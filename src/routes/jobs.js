import { Router } from "express";
import * as jobManager from "../services/job-manager.js";

const router = Router();

router.get("/jobs/:jobId", (req, res) => {
  const job = jobManager.getJob(req.params.jobId);
  res.json({
    jobId: job.id,
    environmentId: job.environment_id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    error: job.error || undefined,
    errorDetails: job.errorDetails,
    createdAt: job.created_at,
    startedAt: job.started_at,
    completedAt: job.completed_at
  });
});

export default router;
