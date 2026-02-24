# @geckorave/payment-gateway-ui

Embeddable React checkout modal for GeckoRave payments.

It provides a ready-to-use payment interface with:
- Card payment
- Card OTP verification (`next_action: "otp"`)
- Redirect continuation (`next_action: "redirect"`)
- Bank transfer account generation
- Transfer verification

The component renders as a full-screen modal when mounted.

## Installation

```bash
npm install geckorave-payment-sdk
```

Peer dependencies required by the package:
- `react` >= 18
- `react-dom` >= 18
- `tailwindcss` >= 3

## Quick Start

```tsx
import React, { useState } from "react";
import { PaymentGateway } from "geckorave-payment-sdk";

export function CheckoutButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open Checkout
      </button>

      {open && (
        <PaymentGateway
          publicKey="pk_test_xxx"
          firstName="John"
          lastName="Doe"
          email="john@example.com"
          phone="08012345678"
          amount={500000}
          currency="NGN"
          callback_url="https://yourapp.com/payments/callback"
          title="GeckoRave Checkout"
          description="Complete your payment securely"
          onSuccess={(data) => {
            console.log("Payment success:", data);
            setOpen(false);
          }}
          onError={(error) => {
            console.error("Payment error:", error);
          }}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
```

## Props

### Required

| Prop | Type | Description |
|---|---|---|
| `publicKey` | `string` | GeckoRave public key (sent as `x-public-key` header). |
| `firstName` | `string` | Customer first name. |
| `lastName` | `string` | Customer last name. |
| `email` | `string` | Customer email address. |
| `phone` | `string` | Customer phone number. |
| `amount` | `number` | Payment amount (minor unit, e.g. `500000` for `NGN 5,000.00`). |
| `currency` | `string` | Currency code (for example `NGN`). |
| `callback_url` | `string` | Your backend/app callback URL for payment completion. |

### Optional

| Prop | Type | Default | Description |
|---|---|---|---|
| `customData` | `Record<string, any>` | `{}` | Extra metadata sent with initialize/pay requests. |
| `reference` | `string` | auto-generated | Custom payment reference. |
| `title` | `string` | - | Checkout title shown in the modal. |
| `description` | `string` | - | Checkout description text. |
| `logo` | `string` | - | Logo image URL. |
| `onSuccess` | `(data: any) => void` | - | Called after successful card/transfer completion (delayed). |
| `onError` | `(error: any) => void` | - | Called on request/verification failures. |
| `onClose` | `() => void` | - | Called when user closes the modal with `Escape`. |
| `successCallbackDelayMs` | `number` | `5000` | Delay before `onSuccess` is triggered (lets users see success UI first). |

## How It Works

### Card Payment Flow

1. Widget initializes a transaction when mounted.
2. User enters card details and PIN.
3. Widget submits payment.
4. Based on response:
   - `next_action: "otp"` -> card inputs are hidden and OTP input is shown.
   - `next_action: "redirect"` -> user is redirected after 5 seconds (or can click "Redirect Now").
   - `status: successful|success|confirmed` -> success UI is shown, then `onSuccess` fires.
5. OTP verification uses.

### Bank Transfer Flow

1. User clicks **Generate Bank Account**.
2. Widget requests bank details.
3. User makes transfer and clicks **I have made the transfer**.
4. Widget verifies status using.
5. If status is:
   - `pending` -> button is disabled for 60 seconds before next verify attempt.
   - `successful|success|confirmed` -> transfer completion UI is shown and `onSuccess` fires.


## Important Notes

- The component currently uses the GeckoRave widget API base URL internally:
  - `https://api.geckorave.com/api/v1/gecko-pay/payment/widget`
- The modal is shown/hidden by mounting/unmounting the component in your app.
- If your app closes the modal immediately after payment success, check your `onSuccess` handler.

## Exported API

```ts
export { PaymentGateway } from "./PaymentGateway";
export type { PaymentProps } from "./PaymentGateway";
```

