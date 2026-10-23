import { redactText } from '../logger';

/** Error raised for any non-2xx Liara response, timeout or network failure (status 0). */
export class LiaraApiError extends Error {
  override name = 'LiaraApiError';
  readonly status: number;
  readonly endpoint: string;
  readonly body?: unknown;
  readonly code?: string;

  constructor(opts: { status: number; endpoint: string; message: string; body?: unknown; code?: string }) {
    super(redactText(opts.message));
    this.status = opts.status;
    this.endpoint = opts.endpoint;
    this.body = opts.body;
    this.code = opts.code;
  }

  /** Short, plain Persian explanation for the end user. */
  get userMessage(): string {
    return userMessageFor(this.status, this.code, this.message);
  }

  get isTimeout(): boolean {
    return this.code === 'TIMEOUT';
  }
}

const BALANCE_HINT = /balance|credit|insufficient|موجودی|اعتبار/i;
/** 428 "Max deployment count in day." — every feature bundle caps deploys per app per day (basic 20, standard 50) [live]. */
const DAILY_DEPLOY_LIMIT = /max deployment count/i;

export function userMessageFor(status: number, code?: string, message = ''): string {
  if (code === 'TIMEOUT') return 'پاسخ لیارا بیش از حد طول کشید (تایم‌اوت). کمی بعد دوباره امتحان می‌کنیم.';
  if (status === 0) return 'ارتباط با لیارا برقرار نشد. اتصال اینترنت یا در دسترس بودن لیارا را بررسی کنید.';
  if (DAILY_DEPLOY_LIMIT.test(message)) return 'سقف تعداد انتشار روزانه‌ی این سرویس پر شده است (بسته‌ی امکانات basic بیست بار در روز اجازه می‌دهد). تا فردا صبر کنید یا از پنل لیارا بسته‌ی امکانات سرویس را ارتقا دهید.';
  if (status === 402 || BALANCE_HINT.test(message)) return 'موجودی حساب لیارا کافی نیست. لطفاً از پنل لیارا حساب را شارژ کنید.';
  if (status === 401) return 'توکن API لیارا نامعتبر است یا منقضی شده. یک توکن تازه از پنل لیارا بگیرید.';
  if (status === 403) return 'اجازه‌ی انجام این کار با این توکن وجود ندارد (دسترسی محدود است).';
  if (status === 404) return 'موردی که خواستید در لیارا پیدا نشد؛ شاید نام سرویس اشتباه است.';
  if (status === 409) return 'این نام قبلاً استفاده شده است؛ یک نام دیگر انتخاب کنید.';
  if (status === 429) return 'تعداد درخواست‌ها به لیارا زیاد شده (محدودیت نرخ). چند لحظه صبر می‌کنیم.';
  if (status >= 500) return 'خطایی سمت سرورهای لیارا رخ داد. کمی بعد دوباره امتحان می‌کنیم.';
  if (status === 400 || status === 422) return 'لیارا این درخواست را نپذیرفت؛ ورودی‌ها را بررسی می‌کنیم.';
  return 'خطای غیرمنتظره در ارتباط با لیارا رخ داد.';
}

/** Extracts a human message from typical Liara error bodies ({message} / {error} / text). */
export function messageFromBody(body: unknown, fallback: string): string {
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 300);
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    for (const key of ['message', 'error', 'detail', 'msg']) {
      const v = b[key];
      if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 300);
    }
  }
  return fallback;
}

/** Converts anything thrown into a Persian user message + English detail, never leaking secrets. */
export function describeError(err: unknown): { error: string; userMessageFa: string; status?: number } {
  if (err instanceof LiaraApiError) {
    return { error: `${err.endpoint} → ${err.status}: ${err.message}`, userMessageFa: err.userMessage, status: err.status };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { error: redactText(message), userMessageFa: 'در انجام این کار خطای غیرمنتظره‌ای رخ داد.' };
}
