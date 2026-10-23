import { z } from 'zod';
import { describeError } from '../liara/errors';
import type { ToolContext, ToolFailure, ToolSuccess } from './registry';

export const appNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Liara app names are lowercase letters, digits and dashes')
  .describe('Liara app name (project_id), e.g. "my-shop"');

export function ok<O>(data: O, summaryFa: string, raw?: unknown): ToolSuccess<O> {
  return raw === undefined ? { ok: true, data, summaryFa } : { ok: true, data, summaryFa, raw };
}

export function fail(err: unknown, userMessageFa?: string): ToolFailure {
  const d = describeError(err);
  return { ok: false, error: d.error, userMessageFa: userMessageFa ?? d.userMessageFa };
}

/** A capability the Liara API does not provide: surfaced to the user as a limitation notice. */
export function limitation(userMessageFa: string, error = 'not available via the Liara API'): ToolFailure {
  return { ok: false, error, userMessageFa, limitation: true };
}

const SECRET_KEY = /secret|password|passwd|token|key|private|credential|auth|dsn/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

export function maskEnvValue(key: string, value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return isSecretKey(key) ? '••••' : value;
}

export function minutesAgo(ctx: ToolContext, minutes: number): Date {
  return new Date(ctx.now().getTime() - minutes * 60_000);
}

export function appUrlFor(ctx: ToolContext, appName: string): string {
  return `https://${appName}${ctx.publicUrlSuffix}`;
}

export function ageMinutes(ctx: ToolContext, iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, Math.round((ctx.now().getTime() - t) / 60_000));
}

export function formatIRT(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return 'نامشخص';
  return `${faNum(Math.round(amount))} تومان`;
}

/** Persian digits for user-facing text («۲۱۶٬۰۰۰», «۰٫۵»); grouping off for ports and ids. */
export function faNum(n: number, opts: { grouping?: boolean; digits?: number } = {}): string {
  return n.toLocaleString('fa-IR', { useGrouping: opts.grouping ?? true, maximumFractionDigits: opts.digits ?? 1 });
}

/** Truncates text to n chars with an ellipsis. */
export function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
