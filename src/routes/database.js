import { Router } from "express";
import { z } from "zod";
import { validate } from "../utils/validate.js";
import * as databaseQueryManager from "../services/database-query-manager.js";

const router = Router();

const querySchema = z.object({
  query: z.string().min(1)
});

// POST .../services/mysql-edi/query { query: "SELECT * FROM users" }
// POST .../services/mongodb-orders/query { query: "db.incidents.find({}).toArray()" }
router.post("/environments/:id/services/:service/query", validate(querySchema), async (req, res) => {
  const { query } = req.validated;
  const result = await databaseQueryManager.runQuery(req.params.id, req.params.service, query);
  res.json(result);
});

export default router;
