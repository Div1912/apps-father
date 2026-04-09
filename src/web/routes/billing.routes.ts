import { Router, Request, Response } from "express";
import { billingService } from "../../services/billing.service";

const router = Router();

router.post("/ipn", async (req: Request, res: Response) => {
  console.log("[Billing IPN] Received callback:", JSON.stringify(req.body));
  console.log("[Billing IPN] Signature header:", req.headers["x-nowpayments-sig"] || "(none)");

  try {
    const hmac = req.headers["x-nowpayments-sig"] as string || "";
    await billingService.handleIPN(req.body, hmac);
    console.log("[Billing IPN] Processed successfully");
    res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error("[Billing IPN] Error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// Simple GET to verify the endpoint is reachable
router.get("/ipn", (_req: Request, res: Response) => {
  res.json({ status: "IPN endpoint active" });
});

export default router;
