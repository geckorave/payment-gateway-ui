<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Validator;
use Illuminate\Support\Str;

class PaymentController extends Controller
{
    /**
     * Initialize a payment intent.
     */
    public function initialize(Request $request): JsonResponse
    {
        if ($tlsResponse = $this->requireTlsInProduction($request)) {
            return $tlsResponse;
        }

        $validated = Validator::make($request->all(), [
            'public_key' => ['required', 'string', 'max:255'],
            'amount' => ['required', 'integer', 'min:100'],
            'currency' => ['required', 'string', 'size:3'],
            'callback_url' => ['required', 'url', 'max:2048'],
            'customer' => ['required', 'array'],
            'customer.first_name' => ['required', 'string', 'max:100'],
            'customer.last_name' => ['required', 'string', 'max:100'],
            'customer.email' => ['required', 'email:rfc', 'max:255'],
            'customer.phone' => ['required', 'string', 'max:30'],
            'custom_data' => ['sometimes', 'array'],
        ])->validate();

        $transactionId = (string) Str::uuid();

        Log::info('payment.initialize', [
            'transaction_id' => $transactionId,
            'amount' => $validated['amount'],
            'currency' => strtoupper($validated['currency']),
            'customer_email_hash' => hash('sha256', strtolower($validated['customer']['email'])),
        ]);

        return response()->json([
            'status' => 'initialized',
            'transaction_id' => $transactionId,
            'amount' => $validated['amount'],
            'currency' => strtoupper($validated['currency']),
            'message' => 'Payment initialized successfully.',
        ], 201);
    }

    /**
     * Submit card payment.
     * PCI-oriented notes:
     * - Validates PAN, expiry, CVV, PIN format.
     * - Luhn validation for PAN.
     * - No storage/logging of PAN, CVV, or PIN.
     * - Return only masked card metadata.
     */
    public function cardPayment(Request $request): JsonResponse
    {
        if ($tlsResponse = $this->requireTlsInProduction($request)) {
            return $tlsResponse;
        }

        $validator = Validator::make($request->all(), [
            'transaction_id' => ['required', 'uuid'],
            'amount' => ['required', 'integer', 'min:100'],
            'currency' => ['required', 'string', 'size:3'],
            'customer' => ['required', 'array'],
            'customer.email' => ['required', 'email:rfc', 'max:255'],
            'card' => ['required', 'array'],
            'card.number' => ['required', 'string', 'regex:/^[0-9 ]{12,23}$/'],
            'card.expiry' => ['required', 'string', 'regex:/^(0[1-9]|1[0-2])\/\d{2}$/'],
            'card.cvv' => ['required', 'string', 'regex:/^\d{3,4}$/'],
            'card.pin' => ['required', 'string', 'regex:/^\d{4}$/'],
        ], [
            'card.pin.regex' => 'Card PIN must be exactly 4 digits.',
            'card.expiry.regex' => 'Expiry must be in MM/YY format.',
        ]);

        $validator->after(function ($validator) use ($request): void {
            $pan = preg_replace('/\D+/', '', (string) $request->input('card.number', ''));
            $expiry = (string) $request->input('card.expiry', '');

            if ($pan === '' || ! $this->passesLuhn($pan)) {
                $validator->errors()->add('card.number', 'Invalid card number.');
            }

            if ($expiry !== '' && ! $this->isExpiryNotPast($expiry)) {
                $validator->errors()->add('card.expiry', 'Card expiry date cannot be in the past.');
            }
        });

        $validated = $validator->validate();

        $pan = preg_replace('/\D+/', '', (string) $validated['card']['number']);
        $brand = $this->detectCardBrand($pan);
        $last4 = substr($pan, -4);


        $gatewayToken = $this->tokenizeForGateway([
            'number' => $pan,
            'expiry' => $validated['card']['expiry'],
            'cvv' => $validated['card']['cvv'],
            'pin' => $validated['card']['pin'],
        ]);

        // Best-effort cleanup of sensitive variables in memory.
        unset($validated['card']['number'], $validated['card']['cvv'], $validated['card']['pin'], $pan);

        Log::info('payment.card.submitted', [
            'transaction_id' => $validated['transaction_id'],
            'brand' => $brand,
            'last4' => $last4,
            'gateway_token_fingerprint' => hash('sha256', $gatewayToken),
        ]);

        return response()->json([
            'status' => 'processing',
            'transaction_id' => $validated['transaction_id'],
            'message' => 'Card payment submitted securely.',
            'card' => [
                'brand' => $brand,
                'last4' => $last4,
            ],
        ], 202);
    }

    private function requireTlsInProduction(Request $request): ?JsonResponse
    {
        if (app()->environment('production') && ! $request->isSecure()) {
            return response()->json([
                'message' => 'HTTPS is required for card payment operations.',
            ], 426);
        }

        return null;
    }

    private function passesLuhn(string $pan): bool
    {
        $sum = 0;
        $double = false;

        for ($i = strlen($pan) - 1; $i >= 0; $i--) {
            $digit = (int) $pan[$i];
            if ($double) {
                $digit *= 2;
                if ($digit > 9) {
                    $digit -= 9;
                }
            }
            $sum += $digit;
            $double = ! $double;
        }

        return $sum % 10 === 0;
    }

    private function isExpiryNotPast(string $expiry): bool
    {
        [$month, $year] = explode('/', $expiry);
        $monthInt = (int) $month;
        $yearInt = 2000 + (int) $year;

        if ($monthInt < 1 || $monthInt > 12) {
            return false;
        }

        $cardMonth = CarbonImmutable::create($yearInt, $monthInt, 1)->startOfMonth();
        $currentMonth = CarbonImmutable::now()->startOfMonth();

        return $cardMonth->greaterThanOrEqualTo($currentMonth);
    }

    private function detectCardBrand(string $pan): string
    {
        return match (true) {
            preg_match('/^4/', $pan) === 1 => 'visa',
            preg_match('/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/', $pan) === 1 => 'mastercard',
            preg_match('/^3[47]/', $pan) === 1 => 'amex',
            preg_match('/^(6011|65|64[4-9]|622)/', $pan) === 1 => 'discover',
            preg_match('/^(5060|5061|5078|5079|6500)/', $pan) === 1 => 'verve',
            default => 'unknown',
        };
    }

    private function tokenizeForGateway(array $cardPayload): string
    {
        return base64_encode(hash('sha256', json_encode($cardPayload, JSON_THROW_ON_ERROR), true));
    }
}

