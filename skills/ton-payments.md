# TON Payments Skill — TON Connect Integration

## Overview

Accept TON cryptocurrency payments in your Mini App using TON Connect.
Flow: User connects wallet via TON Connect → sends transaction with unique payload → backend verifies transaction on-chain.

## Frontend Setup

### 1. Add TON Connect manifest

Create `frontend/tonconnect-manifest.json`:

```json
{
  "url": "APP_URL_HERE",
  "name": "APP_NAME_HERE",
  "iconUrl": "APP_URL_HERE/assets/icon.png"
}
```

Replace `APP_URL_HERE` with the actual app URL (e.g. `https://apps-father.com/app/{projectId}`).

### 2. Include required SDKs

Add to `index.html` `<head>`:

```html
<script src="https://unpkg.com/@tonconnect/ui@2.0.9/dist/tonconnect-ui.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/tonweb@0.0.36/dist/tonweb.min.js"></script>
```

TonWeb is required for building the correct payload Cell format.

### 3. Initialize TON Connect

In `app.js`:

```js
const tonConnectUI = new TON_CONNECT_UI.TonConnectUI({
  manifestUrl: window.location.origin + window.location.pathname + 'tonconnect-manifest.json',
  buttonRootId: 'ton-connect-button'
});
```

Add a container in HTML: `<div id="ton-connect-button"></div>`

### 4. Send Payment Transaction

CRITICAL: The payload MUST be encoded as a TON Cell using TonWeb. Raw strings will NOT work.

```js
async function payWithTon(amountTon, itemName) {
  // Ensure wallet is connected
  if (!tonConnectUI.wallet) {
    tonConnectUI.openModal();
    return;
  }

  // Get payment details from backend
  const resp = await apiCall('/api/{projectId}/ton-pay', {
    method: 'POST',
    body: JSON.stringify({ amount: amountTon, item: itemName })
  });
  const { paymentId, walletAddress, amountNano } = await resp.json();

  // Build payload Cell (REQUIRED format for TON transactions)
  const payloadCell = new TonWeb.boc.Cell();
  payloadCell.bits.writeUint(0, 32); // op code = 0 (text comment)
  payloadCell.bits.writeString(paymentId);

  const transaction = {
    validUntil: Math.floor(Date.now() / 1000) + 600,
    messages: [{
      address: walletAddress,
      amount: amountNano,
      payload: TonWeb.utils.bytesToBase64(await payloadCell.toBoc())
    }]
  };

  try {
    const result = await tonConnectUI.sendTransaction(transaction);
    console.log('TX sent:', result);
    // After TX sent, poll backend for confirmation
    await waitForConfirmation(paymentId);
  } catch (err) {
    console.error('Transaction rejected:', err);
    alert('Payment cancelled');
  }
}

async function waitForConfirmation(paymentId) {
  const maxAttempts = 60;
  for (let i = 0; i < maxAttempts; i++) {
    const resp = await apiCall('/api/{projectId}/ton-verify', {
      method: 'POST',
      body: JSON.stringify({ paymentId })
    });
    const data = await resp.json();
    if (data.confirmed) {
      return true;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Payment verification timeout');
}
```

Replace `{projectId}` with the actual project ID variable.

NEVER pass a raw string as payload. ALWAYS use `TonWeb.boc.Cell` with `writeUint(0, 32)` + `writeString(paymentId)` and then `TonWeb.utils.bytesToBase64(await cell.toBoc())`.

## Backend Setup (routes.js)

### Payment initiation endpoint

```js
router.post('/ton-pay', (req, res) => {
  try {
    const userId = getUserId(req);
    const { amount, item } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const paymentId = 'ton_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 8);
    const amountNano = Math.round(amount * 1e9).toString();
    const walletAddress = 'WALLET_ADDRESS_HERE';

    const payments = db.get('ton_payments') || [];
    payments.push({
      paymentId,
      userId,
      amount,
      amountNano,
      item: item || 'purchase',
      status: 'pending',
      createdAt: new Date().toISOString()
    });
    db.set('ton_payments', payments);

    res.json({ paymentId, walletAddress, amountNano });
  } catch (err) {
    console.error('TON pay error:', err);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});
```

The `WALLET_ADDRESS_HERE` must be replaced with the actual wallet address provided in the PAID FEATURES STATUS section of the prompt.

### Payment verification endpoint

```js
router.post('/ton-verify', async (req, res) => {
  try {
    const { paymentId } = req.body;
    if (!paymentId) return res.status(400).json({ error: 'Missing paymentId' });

    const payments = db.get('ton_payments') || [];
    const payment = payments.find(p => p.paymentId === paymentId);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });

    if (payment.status === 'completed') {
      return res.json({ confirmed: true });
    }

    // Check recent transactions on the wallet
    const walletAddress = 'WALLET_ADDRESS_HERE';
    const response = await fetch(
      `https://toncenter.com/api/v3/transactions?account=${walletAddress}&limit=20`
    );
    const data = await response.json();

    if (data.transactions) {
      for (const tx of data.transactions) {
        // Check if incoming message body contains our paymentId
        const inMsg = tx.in_msg;
        if (inMsg && inMsg.message_content && inMsg.message_content.body) {
          const body = inMsg.message_content.body;
          if (body.includes(paymentId)) {
            // Verify amount matches
            const receivedNano = inMsg.value;
            if (BigInt(receivedNano) >= BigInt(payment.amountNano)) {
              payment.status = 'completed';
              payment.txHash = tx.hash;
              payment.completedAt = new Date().toISOString();
              db.set('ton_payments', payments);
              return res.json({ confirmed: true });
            }
          }
        }
      }
    }

    res.json({ confirmed: false });
  } catch (err) {
    console.error('TON verify error:', err);
    res.json({ confirmed: false });
  }
});
```

### Get user payment history

```js
router.get('/ton-payments', (req, res) => {
  const userId = getUserId(req);
  const payments = db.get('ton_payments') || [];
  const userPayments = payments.filter(p => p.userId === userId);
  res.json({ payments: userPayments });
});
```

## IMPORTANT RULES

- Always use the wallet address from the PAID FEATURES STATUS — do NOT hardcode a random address
- **PAYLOAD FORMAT**: NEVER pass a raw string as `payload`. Always build a `TonWeb.boc.Cell`, write `writeUint(0, 32)` (text comment op code) then `writeString(paymentId)`, and encode with `TonWeb.utils.bytesToBase64(await cell.toBoc())`. Passing raw strings causes transaction failures.
- Always include `<script src="https://cdn.jsdelivr.net/npm/tonweb@0.0.36/dist/tonweb.min.js"></script>` in `index.html` for TonWeb
- Use `tonConnectUI.wallet` to check connection status, and `tonConnectUI.openModal()` to prompt connection
- Use `amountNano` (1 TON = 1,000,000,000 nanoTON) for transaction amounts — calculate as `Math.round(amount * 1e9).toString()`
- Poll with 2-second intervals, max 60 attempts (2 minutes timeout)
- Always store payments in `db.set('ton_payments', [...])` for persistence
- Handle wallet disconnection gracefully in the UI
- Show loading/pending state while waiting for confirmation
- The TON Connect button should be visible but unobtrusive in the UI
