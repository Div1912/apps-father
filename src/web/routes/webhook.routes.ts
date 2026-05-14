import { Router, Request, Response } from "express";
import { config } from "../../config";
import { botRunnerService } from "../../services/bot-runner.service";
import { botForwarderService } from "../../services/bot-forwarder.service";

const router = Router();

router.post("/:tokenHash", (req: Request, res: Response) => {
  const tokenHash = String(req.params.tokenHash);

  // Worker / docker mode: forward to the per-project worker via /__worker/bot-update.
  // In-process mode: dispatch via the legacy in-process bot runner.
  const handler =
    config.isWorkerRuntime
      ? botForwarderService.getWebhookHandler(tokenHash)
      : botRunnerService.getWebhookHandler(tokenHash);

  if (!handler) {
    res.status(404).json({ error: "Bot not found" });
    return;
  }

  handler(req, res, () => {
    res.status(200).end();
  });
});

export default router;
