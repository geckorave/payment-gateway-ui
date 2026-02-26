import styles from "./tailwind.css?inline";
import React, {useEffect, useMemo, useRef, useState} from "react";
import {createPortal} from "react-dom";
import axios, {AxiosError} from "axios";

export interface PaymentProps {
    publicKey: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    amount: number;
    customData?: Record<string, any>;
    onSuccess?: (data: any) => void;
    onError?: (error: any) => void;
    onClose?: () => void;
    successCallbackDelayMs?: number;
    baseUrl?: string;
    paymentTabs?: Array<"card" | "transfer">;
    defaultTab?: "card" | "transfer";
    callback_url: string;
    reference?: string;
    title?: string;
    description?: string;
    logo?: string;
    currency: string;
}

type InitState =
    | { status: "idle" | "loading" }
    | { status: "success"; data: any }
    | { status: "error"; error: string };

type ActiveTab = "card" | "transfer";
type CardNextAction = "none" | "otp" | "redirect" | "success";

const DEFAULT_BASE_URL = "https://api.geckorave.com/api/v1/gecko-pay/payment/widget";

const normalizePaymentTabs = (tabs?: Array<"card" | "transfer">): ActiveTab[] => {
    const source = Array.isArray(tabs) && tabs.length > 0 ? tabs : ["card", "transfer"];
    const unique = Array.from(new Set(source)).filter((tab): tab is ActiveTab => tab === "card" || tab === "transfer");
    return unique.length > 0 ? unique : ["card", "transfer"];
};

const initRequestCache = new Map<string, Promise<any>>();

function stableSerialize(value: unknown): string {
    const seen = new WeakSet<object>();

    const normalize = (input: unknown): unknown => {
        if (input === null || typeof input !== "object") return input;
        if (input instanceof Date) return input.toISOString();
        if (Array.isArray(input)) return input.map(normalize);
        if (seen.has(input as object)) return "[Circular]";

        seen.add(input as object);

        return Object.keys(input as Record<string, unknown>)
            .sort()
            .reduce<Record<string, unknown>>((acc, key) => {
                const next = (input as Record<string, unknown>)[key];
                if (typeof next === "undefined" || typeof next === "function" || typeof next === "symbol") {
                    return acc;
                }
                acc[key] = normalize(next);
                return acc;
            }, {});
    };

    try {
        return JSON.stringify(normalize(value));
    } catch {
        return String(value);
    }
}

const Spinner = () => (
    <div className="relative h-10 w-10">
        <div className="absolute inset-0 rounded-full border-4 border-white/20"/>
        <div className="absolute inset-0 animate-spin rounded-full border-4 border-transparent border-r-white border-t-white"/>
    </div>
);

const Field = ({label, children}: React.PropsWithChildren<{ label: string }>) => (
    <label className="mb-3 block text-sm">
        <span className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.06em] text-gray-500">{label}</span>
        {children}
    </label>
);

const ReadonlyRow = ({label, value}: { label: string; value: string }) => (
    <div className="rounded-xl border border-gray-200 bg-white px-3 py-2 shadow-sm">
        <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-gray-500">{label}</div>
        <div className="mt-1 break-all text-sm font-semibold text-gray-900">{value}</div>
    </div>
);

const DEFAULT_LOGO = (
    <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-[#6c3244] via-[#8f425c] to-[#4f2231] text-sm font-bold text-white shadow-md">
        GR
    </div>
);

const copyToClipboard = async (value: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(textarea);

    if (!copied) {
        throw new Error("Clipboard copy failed");
    }
};

const formatAmount = (minor: number, currency = "NGN") =>
    new Intl.NumberFormat("en-GB", {style: "currency", currency}).format(minor / 100);

const formatCountdown = (seconds: number) => {
    const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
    const secs = (seconds % 60).toString().padStart(2, "0");
    return `${mins}:${secs}`;
};

const detectCardType = (cardNumber: string) => {
    if (/^4/.test(cardNumber)) {
        return {label: "Visa", lengths: [13, 16, 19]};
    }
    if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(cardNumber)) {
        return {label: "Mastercard", lengths: [16]};
    }
    if (/^3[47]/.test(cardNumber)) {
        return {label: "American Express", lengths: [15]};
    }
    if (/^(6011|65|64[4-9]|622)/.test(cardNumber)) {
        return {label: "Discover", lengths: [16, 19]};
    }
    if (/^(5060|5061|5078|5079|6500)/.test(cardNumber)) {
        return {label: "Verve", lengths: [16, 18, 19]};
    }
    return {label: "Unknown", lengths: [12, 13, 14, 15, 16, 17, 18, 19]};
};

const isValidLuhn = (cardNumber: string) => {
    let sum = 0;
    let shouldDouble = false;
    for (let i = cardNumber.length - 1; i >= 0; i -= 1) {
        const digit = Number(cardNumber[i]);
        if (Number.isNaN(digit)) return false;
        let value = digit;
        if (shouldDouble) {
            value *= 2;
            if (value > 9) value -= 9;
        }
        sum += value;
        shouldDouble = !shouldDouble;
    }
    return sum % 10 === 0;
};

const isValidExpiry = (value: string) => {
    if (!/^\d{2}\/\d{2}$/.test(value)) return false;
    const [monthText, yearText] = value.split("/");
    const month = Number(monthText);
    const year = Number(yearText);
    if (!month || month < 1 || month > 12 || Number.isNaN(year)) return false;

    const now = new Date();
    const currentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const enteredMonth = new Date(2000 + year, month - 1, 1);
    return enteredMonth >= currentMonth;
};

export const PaymentGateway: React.FC<PaymentProps> = ({
    publicKey, firstName, lastName, email, phone, amount, customData, onSuccess, onError, onClose, successCallbackDelayMs = 5000, baseUrl, paymentTabs, defaultTab, callback_url, reference, title, description, logo, currency,
}) => {
    const renderInPortal = (node: React.ReactNode) => (
        typeof document !== "undefined" ? createPortal(node, document.body) : <>{node}</>
    );

    const baseURL = (baseUrl ?? "").trim() || DEFAULT_BASE_URL;
    const availableTabs = useMemo(() => normalizePaymentTabs(paymentTabs), [paymentTabs]);
    const preferredDefaultTab: ActiveTab | null = defaultTab === "card" || defaultTab === "transfer" ? defaultTab : null;

    const inputClass = "w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-gray-900 outline-none transition focus:border-[#6c3244] focus:ring-2 focus:ring-[#6c3244]/20";
    const primaryBtn = "w-full rounded-xl bg-[#6c3244] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#552637] disabled:cursor-not-allowed disabled:opacity-60";
    const secondaryBtn = "rounded-xl border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 transition hover:bg-gray-50";

    const [init, setInit] = useState<InitState>({status: "idle"});
    const [isDismissed, setIsDismissed] = useState(false);
    const [overlay, setOverlay] = useState(false);
    const [active, setActive] = useState<ActiveTab>(() => (
        preferredDefaultTab && availableTabs.includes(preferredDefaultTab) ? preferredDefaultTab : availableTabs[0]
    ));
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [successMsg, setSuccessMsg] = useState<string | null>(null);
    const [transactionId, setTransactionId] = useState<string | null>(null);
    const [cardStep, setCardStep] = useState<1 | 2>(1);
    const [cardNumber, setCardNumber] = useState("");
    const [expiry, setExpiry] = useState("");
    const [cvv, setCvv] = useState("");
    const [pin, setPin] = useState("");
    const [cardOtp, setCardOtp] = useState("");
    const [cardNextAction, setCardNextAction] = useState<CardNextAction>("none");
    const [cardSuccessData, setCardSuccessData] = useState<any>(null);
    const [cardRedirectUrl, setCardRedirectUrl] = useState<string | null>(null);
    const [cardRedirectCountdownSec, setCardRedirectCountdownSec] = useState(0);
    const [transferStep, setTransferStep] = useState<1 | 2>(1);
    const [bankDetails, setBankDetails] = useState<null | {
        bankName: string; accountName: string; accountNumber: string; referenceCode: string;
    }>(null);
    const [transferVerifyCooldownSec, setTransferVerifyCooldownSec] = useState(0);
    const [transferVerified, setTransferVerified] = useState(false);
    const [paymentReference] = useState(
        () => reference ?? `GR-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
    );
    const [initRetryTick, setInitRetryTick] = useState(0);
    const customDataSignature = stableSerialize(customData ?? {});
    const successCallbackTimerRef = useRef<number | null>(null);
    const cardRedirectTimerRef = useRef<number | null>(null);
    const cardRedirectCountdownTimerRef = useRef<number | null>(null);

    const client = useMemo(() => axios.create({
        baseURL: baseURL.replace(/\/+$/, ""),
        headers: {"x-public-key": publicKey, "Accept": "application/json"},
    }), [baseURL, publicKey]);

    useEffect(() => {
        const styleTag = document.createElement("style");
        styleTag.setAttribute("data-geckorave", "styles");
        styleTag.innerHTML = styles;
        document.head.appendChild(styleTag);
        return () => {
            document.head.removeChild(styleTag);
        };
    }, []);

    useEffect(() => () => {
        if (successCallbackTimerRef.current !== null) {
            window.clearTimeout(successCallbackTimerRef.current);
        }
        if (cardRedirectTimerRef.current !== null) {
            window.clearTimeout(cardRedirectTimerRef.current);
        }
        if (cardRedirectCountdownTimerRef.current !== null) {
            window.clearInterval(cardRedirectCountdownTimerRef.current);
        }
    }, []);

    useEffect(() => {
        if (isDismissed) return;

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            setIsDismissed(true);
            onClose?.();
        };

        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [isDismissed, onClose]);

    useEffect(() => {
        if (transferVerifyCooldownSec <= 0) return;
        const timer = window.setInterval(() => {
            setTransferVerifyCooldownSec((seconds) => (seconds <= 1 ? 0 : seconds - 1));
        }, 1000);
        return () => window.clearInterval(timer);
    }, [transferVerifyCooldownSec]);

    useEffect(() => {
        if (availableTabs.includes(active)) return;
        setActive(preferredDefaultTab && availableTabs.includes(preferredDefaultTab) ? preferredDefaultTab : availableTabs[0]);
    }, [active, availableTabs, preferredDefaultTab]);

    const clearCardRedirectTimers = () => {
        if (cardRedirectTimerRef.current !== null) {
            window.clearTimeout(cardRedirectTimerRef.current);
            cardRedirectTimerRef.current = null;
        }
        if (cardRedirectCountdownTimerRef.current !== null) {
            window.clearInterval(cardRedirectCountdownTimerRef.current);
            cardRedirectCountdownTimerRef.current = null;
        }
        setCardRedirectCountdownSec(0);
    };

    const resetCardAuthFlow = () => {
        clearCardRedirectTimers();
        setCardNextAction("none");
        setCardSuccessData(null);
        setCardRedirectUrl(null);
        setCardOtp("");
    };

    const showCardSuccessState = (payload: any, message?: string) => {
        clearCardRedirectTimers();
        setCardNextAction("success");
        setCardSuccessData(payload);
        setCardOtp("");
        setCardRedirectUrl(null);
        setSuccessMsg(message || payload?.message || "Payment successful.");
    };

    const queueSuccessCallback = (payload: any) => {
        if (successCallbackTimerRef.current !== null) {
            window.clearTimeout(successCallbackTimerRef.current);
        }
        successCallbackTimerRef.current = window.setTimeout(() => {
            onSuccess?.(payload);
            successCallbackTimerRef.current = null;
        }, Math.max(0, successCallbackDelayMs));
    };

    const startRedirectCountdown = (url: string) => {
        clearCardRedirectTimers();
        setCardNextAction("redirect");
        setCardRedirectUrl(url);
        setCardRedirectCountdownSec(5);
        setSuccessMsg("Redirect required. You will be redirected in 5 seconds to continue payment.");

        cardRedirectCountdownTimerRef.current = window.setInterval(() => {
            setCardRedirectCountdownSec((seconds) => (seconds <= 1 ? 0 : seconds - 1));
        }, 1000);

        cardRedirectTimerRef.current = window.setTimeout(() => {
            window.location.assign(url);
        }, 5000);
    };

    useEffect(() => {
        let mounted = true;
        const initPayment = async () => {
            setInit({status: "loading"});
            setErrorMsg(null);
            setSuccessMsg(null);
            try {
                const payload = {
                    public_key: publicKey,
                    amount,
                    currency,
                    reference: paymentReference,
                    callback_url,
                    customer: {
                        first_name: firstName,
                        last_name: lastName,
                        email,
                        phone,
                    },
                    custom_data: customData ?? {},
                };
                const requestKey = stableSerialize({
                    baseURL: client.defaults.baseURL,
                    path: "/initialize",
                    publicKey,
                    payload,
                });

                let request = initRequestCache.get(requestKey);
                if (!request) {
                    request = client
                        .post("/initialize", payload)
                        .then(({data}) => data?.data ?? data)
                        .finally(() => {
                            if (initRequestCache.get(requestKey) === request) {
                                initRequestCache.delete(requestKey);
                            }
                        });
                    initRequestCache.set(requestKey, request);
                }

                const plain = await request;
                if (!mounted) return;
                const tId =
                    plain?.data?.transaction_id ||
                    plain?.data?.transactionId ||
                    plain?.transaction_id ||
                    plain?.transactionId ||
                    plain?.data?.id ||
                    plain?.id ||
                    plain?.data?.reference ||
                    plain?.reference ||
                    null;
                setTransactionId(tId);
                setInit({status: "success", data: plain});
            } catch (err) {
                const e = err as AxiosError<any>;
                const msg = (e.response?.data as any)?.message || e.message || "Unable to initialize payment, please try again.";
                if (!mounted) return;
                setInit({status: "error", error: msg});
                setErrorMsg(msg);
            }
        };
        initPayment();
        return () => {
            mounted = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [amount, currency, customDataSignature, email, firstName, lastName, phone, publicKey, callback_url, paymentReference, initRetryTick]);

    const onCardNumberChange = (v: string) => setCardNumber(v.replace(/\D/g, "").slice(0, 19).replace(/(.{4})/g, "$1 ").trim());
    const onExpiryChange = (v: string) => {
        const d = v.replace(/\D/g, "").slice(0, 4);
        setExpiry(d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d);
    };

    const cardDigits = cardNumber.replace(/\s+/g, "");
    const cardMeta = detectCardType(cardDigits);
    const cardTypeLabel = cardDigits ? cardMeta.label : "Unknown";
    const cardNumberValid = /^\d{12,19}$/.test(cardDigits) && cardMeta.lengths.includes(cardDigits.length) && isValidLuhn(cardDigits);
    const showCardNumberError = cardDigits.length >= 12 && !cardNumberValid;
    const expiryValid = isValidExpiry(expiry);
    const showExpiryError = expiry.length === 5 && !expiryValid;
    const pinValid = pin.length === 4;
    const showPinError = pin.length > 0 && !pinValid;
    const cvvValid = cvv.length >= 3;

    const cardStepOneValid = cardNumberValid && expiryValid && cvvValid;
    const canSubmitCard = cardStepOneValid && pinValid;

    const submit = async (method: "card" | "transfer") => {
        if (method === "card") {
            if (!cardNumberValid) {
                setErrorMsg("Please enter a valid card number.");
                return;
            }
            if (!expiryValid) {
                setErrorMsg("Please enter a valid expiry date (MM/YY). Past dates are not allowed.");
                return;
            }
            if (!pinValid) {
                setErrorMsg("Card PIN must be exactly 4 digits.");
                return;
            }
        }

        setOverlay(true);
        setErrorMsg(null);
        setSuccessMsg(null);
        try {
            if (method === "card") {
                resetCardAuthFlow();
            }
            const basePayload = {
                transaction_id: transactionId,
                reference: paymentReference,
                method,
                amount,
                currency,
                customer: {
                    first_name: firstName,
                    last_name: lastName,
                    email,
                    phone,
                },
                custom_data: customData ?? {},
            };
            const payload = method === "card"
                ? {...basePayload, card: {number: cardNumber.replace(/\s+/g, ""), expiry, cvv, pin}}
                : {...basePayload};
            const {data} = await client.post("/pay", payload);
            const plain = data?.data ?? data;

            if (method === "card") {
                const rawStatus = String(plain?.status ?? "").toLowerCase();
                const nextAction = String(plain?.next_action ?? "").toLowerCase();
                const payMessage = plain?.message || "Card payment response received.";
                const redirectUrl = plain?.redirect_url || plain?.redirectUrl || null;

                if (nextAction === "otp") {
                    setCardNextAction("otp");
                    setCardOtp("");
                    setSuccessMsg(payMessage);
                    return;
                }

                if (nextAction === "redirect") {
                    if (!redirectUrl) {
                        setErrorMsg("Redirect payment requires a redirect URL, but none was returned.");
                        return;
                    }
                    startRedirectCountdown(String(redirectUrl));
                    return;
                }

                if (["successful", "success", "confirmed"].includes(rawStatus)) {
                    showCardSuccessState(plain, plain?.message || "Payment successful.");
                    queueSuccessCallback(plain);
                    return;
                }

                if (rawStatus === "pending") {
                    setErrorMsg(payMessage);
                    return;
                }
            }

            setSuccessMsg("Payment successful.");
            queueSuccessCallback(plain);
        } catch (err) {
            const e = err as AxiosError<any>;
            const msg = (e.response?.data as any)?.message || e.message || "Payment failed. Please try again.";
            setErrorMsg(msg);
            onError?.(err);
        } finally {
            setOverlay(false);
        }
    };

    const verifyCardOtp = async () => {
        if (!transactionId) {
            setErrorMsg("Transaction could not be initialized. Please retry.");
            return;
        }

        const otp = cardOtp.trim();
        if (!otp) {
            setErrorMsg("Please enter the OTP sent to the customer.");
            return;
        }

        setOverlay(true);
        setErrorMsg(null);
        setSuccessMsg(null);
        try {
            const {data} = await client.post("/verify-otp", {
                transaction_id: transactionId,
                reference: paymentReference,
                method: "card",
                otp,
            });

            const plain = data?.data ?? data;
            const rawStatus = String(plain?.status ?? "").toLowerCase();
            const nextAction = String(plain?.next_action ?? "").toLowerCase();
            const verifyMessage = plain?.message || (data as any)?.message || "Card verification completed.";
            const redirectUrl = plain?.redirect_url || plain?.redirectUrl || null;

            if (nextAction === "redirect") {
                if (!redirectUrl) {
                    setErrorMsg("Redirect payment requires a redirect URL, but none was returned.");
                    return;
                }
                startRedirectCountdown(String(redirectUrl));
                return;
            }

            if (nextAction === "otp") {
                setCardNextAction("otp");
                setSuccessMsg(verifyMessage);
                return;
            }

            if (["successful", "success", "confirmed"].includes(rawStatus)) {
                showCardSuccessState(plain, plain?.message || "Payment successful.");
                queueSuccessCallback(plain);
                return;
            }

            if (rawStatus === "pending") {
                setCardNextAction("otp");
                setErrorMsg(verifyMessage);
                return;
            }

            setErrorMsg(verifyMessage || "Could not verify OTP. Please try again.");
        } catch (err) {
            const e = err as AxiosError<any>;
            const msg = (e.response?.data as any)?.message || e.message || "Could not verify OTP. Please try again.";
            setErrorMsg(msg);
            onError?.(err);
        } finally {
            setOverlay(false);
        }
    };

    const verifyTransfer = async () => {
        if (transferVerified) return;
        if (transferVerifyCooldownSec > 0) return;
        if (!transactionId) {
            setErrorMsg("Transaction could not be initialized. Please retry.");
            return;
        }

        setOverlay(true);
        setErrorMsg(null);
        setSuccessMsg(null);
        try {
            const {data} = await client.post("/verify", {
                transaction_id: transactionId,
                reference: paymentReference,
            });

            const plain = data?.data ?? data;
            const rawStatus = String(plain?.status ?? "").toLowerCase();
            const verifyMessage = plain?.message || (data as any)?.message || "Verification completed.";

            if (["successful", "success", "confirmed"].includes(rawStatus)) {
                setTransferVerified(true);
                setTransferVerifyCooldownSec(0);
                setSuccessMsg("Transfer confirmed successfully. Transaction is complete.");
                if (successCallbackTimerRef.current !== null) {
                    window.clearTimeout(successCallbackTimerRef.current);
                }
                successCallbackTimerRef.current = window.setTimeout(() => {
                    onSuccess?.(plain);
                    successCallbackTimerRef.current = null;
                }, Math.max(0, successCallbackDelayMs));
                return;
            }

            if (rawStatus === "pending") {
                setErrorMsg(verifyMessage);
                setTransferVerifyCooldownSec(60);
                return;
            }

            setErrorMsg(verifyMessage || "Unable to confirm transfer status right now.");
        } catch (err) {
            const e = err as AxiosError<any>;
            const msg = (e.response?.data as any)?.message || e.message || "Could not verify transfer. Please try again.";
            setErrorMsg(msg);
            onError?.(err);
        } finally {
            setOverlay(false);
        }
    };

    const proceedBank = async () => {
        if (!transactionId) {
            setErrorMsg("Transaction could not be initialized. Please retry.");
            return;
        }
        setOverlay(true);
        setErrorMsg(null);
        setSuccessMsg(null);
        setTransferVerified(false);
        setTransferVerifyCooldownSec(0);
        try {
            const {data} = await client.post("/bank-details", {
                transaction_id: transactionId,
                reference: paymentReference,
                method: "transfer",
                amount,
                currency,
                customer: {
                    first_name: firstName,
                    last_name: lastName,
                    email,
                    phone,
                },
            });
            const plain = data?.data ?? data;
            const bankPayload =
                plain?.data?.bankTransfer ||
                plain?.bankTransfer ||
                plain?.data?.bank ||
                plain?.bank ||
                null;

            const bt = bankPayload
                ? {
                    bankName: bankPayload.bankName ?? bankPayload.bank_name ?? "",
                    accountName: bankPayload.accountName ?? bankPayload.account_name ?? "",
                    accountNumber: bankPayload.accountNumber ?? bankPayload.account_number ?? "",
                    referenceCode: bankPayload.referenceCode ?? bankPayload.reference ?? "",
                }
                : null;

            if (!bt?.accountNumber) {
                setErrorMsg("Bank account details were not returned by the server.");
                return;
            }

            setBankDetails(bt);
            setTransferStep(2);
            setSuccessMsg("Bank account generated successfully. Complete the transfer using the details below.");
        } catch (err) {
            const e = err as AxiosError<any>;
            const msg = (e.response?.data as any)?.message || e.message || "Could not generate bank details.";
            setErrorMsg(msg);
        } finally {
            setOverlay(false);
        }
    };

    if (init.status === "loading" || init.status === "idle") {
        if (isDismissed) return null;
        return renderInPortal(
            <div className="fixed inset-0 z-[2147483647] flex items-center justify-center bg-gradient-to-br from-slate-900/60 via-slate-900/55 to-[#6c3244]/50 backdrop-blur"><Spinner/></div>
        );
    }

    if (isDismissed) return null;

    if (init.status === "error") {
        return renderInPortal(
            <div className="fixed inset-0 z-[2147483647] flex items-center justify-center bg-gradient-to-br from-slate-900/60 via-slate-900/55 to-[#6c3244]/50 backdrop-blur">
                <div className="mx-4 max-w-md rounded-3xl border border-white/20 bg-white p-6 shadow-2xl">
                    <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{init.error}</div>
                    <button
                        onClick={() => {
                            setInit({status: "idle"});
                            setInitRetryTick((tick) => tick + 1);
                        }}
                        className={primaryBtn}
                    >
                        Retry
                    </button>
                </div>
            </div>
        );
    }

    return renderInPortal(
        <div className="fixed inset-0 z-[2147483647] flex items-center justify-center bg-gradient-to-br from-slate-900/60 via-slate-900/55 to-[#6c3244]/50 px-2 backdrop-blur">
            {overlay && <div className="absolute inset-0 flex items-center justify-center bg-black/45"><Spinner/></div>}
            <div className="mx-3 w-full max-w-4xl overflow-hidden rounded-3xl border border-white/30 bg-white/95 shadow-[0_25px_80px_-25px_rgba(15,23,42,0.6)]">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 bg-white px-6 py-4">
                    <div>
                        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-gray-500">Transaction ID</div>
                        <div className="text-sm font-semibold text-gray-900">#{transactionId ?? "--"}</div>
                    </div>
                    <div className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">Secure checkout</div>
                </div>
                <div className="border-b border-gray-200 bg-white px-4 py-4 md:hidden">
                    <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3">
                            {logo ? <img src={logo} alt="Logo" className="h-11 w-11 rounded-xl border border-gray-200 bg-white object-contain p-1"/> : DEFAULT_LOGO}
                            <div className="leading-tight">
                                {title && <div className="text-base font-semibold text-gray-900">{title}</div>}
                                {description && <div className="mt-1 max-w-[200px] text-xs text-gray-500">{description}</div>}
                            </div>
                        </div>
                        <div className="rounded-xl border border-gray-200 bg-white p-2.5 text-right shadow-sm">
                            <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-gray-500">Total Amount</div>
                            <div className="text-sm font-bold text-gray-900">{formatAmount(amount, currency)}</div>
                        </div>
                    </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-12">
                    <aside className="border-b border-gray-200 bg-gradient-to-b from-[#f8eef2] via-[#fbf6f8] to-white p-4 md:col-span-4 md:border-b-0 md:border-r">
                        <div className="mb-4">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.07em] text-gray-500">Payment Method</div>
                            <div className="mt-1 text-sm text-gray-700">
                                {availableTabs.length > 1
                                    ? "Choose your preferred way to pay."
                                    : availableTabs[0] === "card"
                                        ? "Card payment is enabled for this checkout."
                                        : "Bank transfer is enabled for this checkout."}
                            </div>
                        </div>
                        <div className="space-y-2">
                            {availableTabs.includes("card") && (
                                <button type="button" onClick={() => { resetCardAuthFlow(); setActive("card"); setCardStep(1); setErrorMsg(null); setSuccessMsg(null); }} className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${active === "card" ? "border-[#6c3244]/25 bg-white text-[#6c3244] shadow-sm" : "border-transparent bg-white/70 text-gray-700 hover:border-gray-200 hover:bg-white"}`}>
                                    <div className="text-sm font-semibold">Card Payment</div>
                                    <div className="text-xs text-gray-500">Pay with card details securely.</div>
                                </button>
                            )}
                            {availableTabs.includes("transfer") && (
                                <button type="button" onClick={() => { resetCardAuthFlow(); setActive("transfer"); setTransferStep(1); setErrorMsg(null); setSuccessMsg(null); }} className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${active === "transfer" ? "border-[#6c3244]/25 bg-white text-[#6c3244] shadow-sm" : "border-transparent bg-white/70 text-gray-700 hover:border-gray-200 hover:bg-white"}`}>
                                    <div className="text-sm font-semibold">Bank Transfer</div>
                                    <div className="text-xs text-gray-500">Generate account and transfer funds.</div>
                                </button>
                            )}
                        </div>
                        <div className="mt-5 rounded-xl border border-gray-200 bg-white/80 p-3">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-gray-500">Customer</div>
                            <div className="mt-1 text-sm font-semibold text-gray-900">{[firstName, lastName].filter(Boolean).join(" ") || "Guest Customer"}</div>
                            <div className="break-all text-xs text-gray-600">{email}</div>
                        </div>
                    </aside>
                    <section className="p-6 md:col-span-8">
                        <div className="hidden flex-wrap items-start justify-between gap-4 md:flex">
                            <div className="flex items-start gap-3">
                                {logo ? <img src={logo} alt="Logo" className="h-11 w-11 rounded-xl border border-gray-200 bg-white object-contain p-1"/> : DEFAULT_LOGO}
                                <div className="leading-tight">
                                    {title && <div className="text-lg font-semibold text-gray-900">{title}</div>}
                                    {description && <div className="mt-1 max-w-lg text-xs text-gray-500">{description}</div>}
                                </div>
                            </div>
                            <div className="rounded-xl border border-gray-200 bg-white p-3 text-right shadow-sm">
                                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-gray-500">Total Amount</div>
                                <div className="text-base font-bold text-gray-900">{formatAmount(amount, currency)}</div>
                                <div className="max-w-[220px] truncate text-xs text-gray-500">{email}</div>
                            </div>
                        </div>
                        {(errorMsg || successMsg) && (
                            <div className="pt-4">
                                {errorMsg && <div className="mb-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{errorMsg}</div>}
                                {successMsg && <div className="mb-3 rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-700">{successMsg}</div>}
                            </div>
                        )}
                        <div className="mt-5 rounded-2xl border border-gray-200 bg-[#fcfcfd] p-4 sm:p-5">
                            {active === "card" ? (
                                <>
                                    <div className="mb-4 flex items-center gap-2">
                                        <div className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${cardStep === 1 ? "bg-[#6c3244] text-white" : "bg-gray-200 text-gray-600"}`}>1. Card Details</div>
                                        <div className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${cardStep === 2 ? "bg-[#6c3244] text-white" : "bg-gray-200 text-gray-600"}`}>2. Authorize</div>
                                    </div>
                                    {cardStep === 1 ? (
                                        <div>
                                            <Field label="Card Number">
                                                <input
                                                    placeholder="1234 5678 9012 3456"
                                                    value={cardNumber}
                                                    onChange={(e) => onCardNumberChange(e.target.value)}
                                                    className={`${inputClass} ${showCardNumberError ? "border-red-400 focus:border-red-500 focus:ring-red-100" : ""}`}
                                                />
                                                <div className="mt-1 flex items-center justify-between text-xs">
                                                    <span className="font-medium text-gray-600">Card type: {cardTypeLabel}</span>
                                                    {showCardNumberError && <span className="text-red-600">Invalid card number</span>}
                                                </div>
                                            </Field>
                                            <div className="grid grid-cols-2 gap-3">
                                                <Field label="Expiry (MM/YY)">
                                                    <input
                                                        placeholder="MM/YY"
                                                        value={expiry}
                                                        onChange={(e) => onExpiryChange(e.target.value)}
                                                        className={`${inputClass} ${showExpiryError ? "border-red-400 focus:border-red-500 focus:ring-red-100" : ""}`}
                                                    />
                                                    {showExpiryError && <div className="mt-1 text-xs text-red-600">Expiry date cannot be in the past</div>}
                                                </Field>
                                                <Field label="CVV"><input type="password" placeholder="123" value={cvv} onChange={(e) => setCvv(e.target.value.replace(/\D/g, "").slice(0, 4))} className={inputClass}/></Field>
                                            </div>
                                            <button type="button" onClick={() => setCardStep(2)} disabled={!cardStepOneValid} className={`${primaryBtn} mt-4`}>Continue</button>
                                        </div>
                                    ) : cardNextAction === "success" ? (
                                        <div className="rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-5">
                                            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-emerald-100 text-emerald-700">
                                                <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6 fill-none stroke-current" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                    <path d="M20 6 9 17l-5-5"/>
                                                </svg>
                                            </div>
                                            <div className="mt-3 text-center">
                                                <div className="text-base font-semibold text-emerald-800">Payment Successful</div>
                                                <div className="mt-1 text-sm text-emerald-700/90">
                                                    {cardSuccessData?.message || "Your card payment has been completed successfully."}
                                                </div>
                                            </div>
                                            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                                                <ReadonlyRow label="Amount" value={formatAmount(amount, currency)}/>
                                                <ReadonlyRow label="Reference" value={String(cardSuccessData?.reference || paymentReference)}/>
                                                <ReadonlyRow label="Card Brand" value={String(cardSuccessData?.card?.brand || cardTypeLabel || "Card")}/>
                                                <ReadonlyRow label="Card Last 4" value={String(cardSuccessData?.card?.last4 || cardDigits.slice(-4) || "****")}/>
                                            </div>
                                            <div className="mt-4 rounded-xl border border-emerald-200 bg-white p-3 text-xs text-emerald-700">
                                                Transaction is complete. You can wait while we finalize the callback.
                                            </div>
                                        </div>
                                    ) : cardNextAction === "otp" ? (
                                        <div>
                                            <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                                                Enter the OTP sent your phone number to complete your card payment.
                                            </div>
                                            <Field label="OTP">
                                                <input
                                                    type="password"
                                                    inputMode="numeric"
                                                    autoComplete="one-time-code"
                                                    placeholder="Enter OTP"
                                                    value={cardOtp}
                                                    onChange={(e) => setCardOtp(e.target.value.replace(/\D/g, "").slice(0, 8))}
                                                    className={inputClass}
                                                />
                                            </Field>
                                            <div className="mt-4 flex gap-3">
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        resetCardAuthFlow();
                                                        setCardStep(1);
                                                    }}
                                                    className={secondaryBtn}
                                                >
                                                    Back
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={verifyCardOtp}
                                                    disabled={!cardOtp.trim()}
                                                    className={`flex-1 ${primaryBtn}`}
                                                >
                                                    Verify OTP
                                                </button>
                                            </div>
                                        </div>
                                    ) : cardNextAction === "redirect" ? (
                                        <div>
                                            <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
                                                Redirect required to continue payment.
                                            </div>
                                            <div className="mt-3 rounded-xl border border-gray-200 bg-white p-3 text-sm text-gray-700">
                                                Redirecting in <span className="font-semibold">{cardRedirectCountdownSec}</span> seconds...
                                            </div>
                                            <div className="mt-4 flex gap-3">
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        if (cardRedirectUrl) {
                                                            window.location.assign(cardRedirectUrl);
                                                        }
                                                    }}
                                                    className={`flex-1 ${primaryBtn}`}
                                                >
                                                    Redirect Now
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        resetCardAuthFlow();
                                                        setSuccessMsg(null);
                                                    }}
                                                    className={secondaryBtn}
                                                >
                                                    Cancel Redirect
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <div>
                                            <div className="grid grid-cols-2 gap-3">
                                                <Field label="Card Number">
                                                    <input
                                                        placeholder="1234 5678 9012 3456"
                                                        value={cardNumber}
                                                        onChange={(e) => onCardNumberChange(e.target.value)}
                                                        className={`${inputClass} ${showCardNumberError ? "border-red-400 focus:border-red-500 focus:ring-red-100" : ""}`}
                                                    />
                                                    <div className="mt-1 flex items-center justify-between text-xs">
                                                        <span className="font-medium text-gray-600">Card type: {cardTypeLabel}</span>
                                                        {showCardNumberError && <span className="text-red-600">Invalid card number</span>}
                                                    </div>
                                                </Field>
                                                <Field label="Expiry (MM/YY)">
                                                    <input
                                                        placeholder="MM/YY"
                                                        value={expiry}
                                                        onChange={(e) => onExpiryChange(e.target.value)}
                                                        className={`${inputClass} ${showExpiryError ? "border-red-400 focus:border-red-500 focus:ring-red-100" : ""}`}
                                                    />
                                                    {showExpiryError && <div className="mt-1 text-xs text-red-600">Expiry date cannot be in the past</div>}
                                                </Field>
                                            </div>
                                            <div className="mt-3 grid grid-cols-2 gap-3">
                                                <Field label="CVV"><input type="password" placeholder="123" value={cvv} onChange={(e) => setCvv(e.target.value.replace(/\D/g, "").slice(0, 4))} className={inputClass}/></Field>
                                                <Field label="Card PIN">
                                                    <input
                                                        type="password"
                                                        placeholder="****"
                                                        value={pin}
                                                        onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                                                        className={`${inputClass} ${showPinError ? "border-red-400 focus:border-red-500 focus:ring-red-100" : ""}`}
                                                    />
                                                    {showPinError && <div className="mt-1 text-xs text-red-600">PIN must be exactly 4 digits</div>}
                                                </Field>
                                            </div>
                                            <div className="mt-4 flex gap-3">
                                                <button type="button" onClick={() => { resetCardAuthFlow(); setCardStep(1); }} className={secondaryBtn}>Back</button>
                                                <button type="button" onClick={() => submit("card")} disabled={!canSubmitCard} className={`flex-1 ${primaryBtn}`}>Pay Now</button>
                                            </div>
                                        </div>
                                    )}
                                </>
                            ) : (
                                <>
                                    <div className="mb-4 flex items-center gap-2">
                                        <div className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${transferStep === 1 ? "bg-[#6c3244] text-white" : "bg-gray-200 text-gray-600"}`}>1. Generate Account</div>
                                        <div className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${transferStep === 2 ? "bg-[#6c3244] text-white" : "bg-gray-200 text-gray-600"}`}>2. Confirm Transfer</div>
                                    </div>
                                    {transferStep === 1 ? (
                                        <div>
                                            <p className="mb-4 text-sm text-gray-600">A bank account will be generated for you to make payment.</p>
                                            <button type="button" onClick={proceedBank} className={primaryBtn}>Generate Bank Account</button>
                                        </div>
                                    ) : (
                                        bankDetails && (
                                            <div>
                                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                                    <ReadonlyRow label="Bank Name" value={bankDetails.bankName}/>
                                                    <ReadonlyRow label="Account Name" value={bankDetails.accountName}/>
                                                    <div className="rounded-xl border border-gray-200 bg-white px-3 py-2 shadow-sm">
                                                        <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-gray-500">Account Number</div>
                                                        <div className="mt-1 flex items-center justify-between gap-2">
                                                            <div className="min-w-0 break-all text-sm font-semibold text-gray-900">{bankDetails.accountNumber}</div>
                                                            <button
                                                                type="button"
                                                                aria-label="Copy account number"
                                                                title="Copy account number"
                                                                onClick={async () => {
                                                                    try {
                                                                        await copyToClipboard(bankDetails.accountNumber);
                                                                        setErrorMsg(null);
                                                                        setSuccessMsg("Account number copied.");
                                                                    } catch {
                                                                        setErrorMsg("Unable to copy account number. Please copy it manually.");
                                                                    }
                                                                }}
                                                                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-700 transition hover:bg-gray-50"
                                                            >
                                                                <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-none stroke-current" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                                    <rect x="9" y="9" width="13" height="13" rx="2"/>
                                                                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                                                                </svg>
                                                            </button>
                                                        </div>
                                                    </div>
                                                    <ReadonlyRow label="Reference Code" value={bankDetails.referenceCode}/>
                                                </div>
                                                {transferVerified ? (
                                                    <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-700">
                                                        Transaction confirmed. This transfer has been completed.
                                                    </div>
                                                ) : (
                                                    <div className="mt-4">
                                                        <button
                                                            type="button"
                                                            onClick={verifyTransfer}
                                                            disabled={transferVerifyCooldownSec > 0}
                                                            className={`${primaryBtn}`}
                                                        >
                                                            {transferVerifyCooldownSec > 0
                                                                ? `Try again in ${formatCountdown(transferVerifyCooldownSec)}`
                                                                : "I have made the transfer"}
                                                        </button>
                                                        {transferVerifyCooldownSec > 0 && (
                                                            <div className="mt-2 text-xs text-gray-500">
                                                                Verification is temporarily disabled after a pending check to prevent repeated requests.
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        )
                                    )}
                                </>
                            )}
                            <div className="mt-5 flex items-center gap-2 rounded-lg border border-emerald-100 bg-emerald-50/70 px-3 py-2 text-[11px] font-medium text-emerald-700">
                                <span className="h-2 w-2 rounded-full bg-emerald-500"/>
                                <span>Secure 256-bit encrypted connection</span>
                            </div>
                        </div>
                    </section>
                </div>
            </div>
        </div>
    );
};
