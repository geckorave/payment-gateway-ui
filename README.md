# @geckorave/payment-gateway-ui

Embeddable React checkout modal for GeckoRave payments.

Features:
- Card payment
- Card OTP verification (`next_action: "otp"`)
- Redirect continuation (`next_action: "redirect"`) with 5-second delay
- Bank transfer account generation
- Transfer verification with cooldown protection
- Delayed `onSuccess` callback so users can see success UI first

The component renders as a full-screen modal when mounted.

## Installation

```bash
npm install @geckorave/payment-gateway-ui
```

Peer dependencies:
- `react` >= 18
- `react-dom` >= 18
- `tailwindcss` >= 3

## Quick Start

```tsx
import React, { useState } from "react";
import { PaymentGateway } from "@geckorave/payment-gateway-ui";

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
| `amount` | `number` | Payment amount in minor units (example: `500000` for `NGN 5,000.00`). |
| `currency` | `string` | Currency code (example: `NGN`). |
| `callback_url` | `string` | Callback URL for your application/backend. |

### Optional

| Prop | Type | Default | Description |
|---|---|---|---|
| `customData` | `Record<string, any>` | `{}` | Extra metadata sent with initialize/pay requests. |
| `reference` | `string` | auto-generated | Custom payment reference. |
| `title` | `string` | - | Checkout title shown in the modal. |
| `description` | `string` | - | Checkout description text. |
| `logo` | `string` | - | Logo image URL shown in the modal. |
| `onSuccess` | `(data: any) => void` | - | Called after successful card/transfer completion (delayed). |
| `onError` | `(error: any) => void` | - | Called on request/verification failures. |
| `onClose` | `() => void` | - | Called when user closes the modal with `Escape`. |
| `successCallbackDelayMs` | `number` | `5000` | Delay before `onSuccess` is triggered. |
| `baseUrl` | `string` | GeckoRave default API URL | Override the widget API base URL. If empty (`""`) or omitted, the default base URL is used. |
| `paymentTabs` | `Array<"card" \| "transfer">` | `["card", "transfer"]` | Controls which payment methods are shown. |
| `defaultTab` | `"card" \| "transfer"` | first enabled tab | Preferred starting tab. Ignored if not included in `paymentTabs`. |

## Tab Configuration Examples

### Bank Transfer Only

```tsx
<PaymentGateway
  {...props}
  paymentTabs={["transfer"]}
  defaultTab="transfer"
/>
```

### Card Only

```tsx
<PaymentGateway
  {...props}
  paymentTabs={["card"]}
  defaultTab="card"
/>
```

### Both Tabs (Custom Default)

```tsx
<PaymentGateway
  {...props}
  paymentTabs={["card", "transfer"]}
  defaultTab="transfer"
/>
```

## Base URL Override Example

```tsx
<PaymentGateway
  {...props}
  baseUrl="https://api.geckorave.com/api/v1/gecko-pay/payment/widget"
/>
```

If `baseUrl` is `""` or not provided, the component uses:

```txt
https://api.geckorave.com/api/v1/gecko-pay/payment/widget
```

## How It Works

### Card Payment Flow

1. Widget initializes a transaction via `/initialize`.
2. User enters card details and PIN.
3. Widget submits payment via `/pay`.
4. Based on response:
   - `next_action: "otp"`: card inputs are hidden and OTP input is shown.
   - `next_action: "redirect"`: user is redirected after 5 seconds (or can click "Redirect Now").
   - `status: successful|success|confirmed`: success UI is shown, then `onSuccess` fires after `successCallbackDelayMs`.
5. OTP verification is handled via `/verify-otp`.

### Bank Transfer Flow

1. User clicks **Generate Bank Account**.
2. Widget requests bank details via `/bank-details`.
3. User makes transfer and clicks **I have made the transfer**.
4. Widget verifies status via `/verify`.
5. If status is:
   - `pending`: verify button is disabled for 60 seconds.
   - `successful|success|confirmed`: completion UI is shown, then `onSuccess` fires after `successCallbackDelayMs`.

## UX Behavior

- Press `Escape` to close the modal.
- Card OTP success shows a dedicated success UI (card inputs stay hidden).
- Bank transfer account number includes a copy action.
- Redirect-based card flow supports delayed redirect and manual redirect button.
- Buttons use `type="button"` to avoid accidental parent form submission.

## Important Notes

- The modal is shown/hidden by mounting/unmounting the component in your app.
- If your app closes the modal immediately on success, check your `onSuccess` handler.
- `onSuccess` is intentionally delayed (default `5000ms`) so users can see the success state in the modal.

## Exported API

```ts
export { PaymentGateway } from "./PaymentGateway";
export type { PaymentProps } from "./PaymentGateway";
```
