import { Router, Request, Response } from "express";
import { botRunnerService } from "../../services/bot-runner.service";

const router = Router();

router.post("/:tokenHash", (req: Request, res: Response) => {
  const tokenHash = String(req.params.tokenHash);
  const handler = botRunnerService.getWebhookHandler(tokenHash);

  if (!handler) {
    res.status(404).json({ error: "Bot not found" });
    return;
  }

  handler(req, res, () => {
    res.status(200).end();
  });
});

export default router;
