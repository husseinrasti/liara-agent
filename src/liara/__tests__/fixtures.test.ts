/**
 * Parses every sanitized probe fixture (fixtures/liara/*.json) with the schema the
 * client uses for that endpoint. Strict parse: a failure means types.ts drifted
 * from the real API and must be fixed (real shapes beat the spec).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { ROOT_DIR } from '../../config';
import { normalizeEvents, parseLokiLogs } from '../normalize';
import { extractProjectPlans } from '../plans';
import {
  AppletsResponseSchema,
  BillingSchema,
  BuildLogsSchema,
  DomainCheckSchema,
  DomainsResponseSchema,
  EventsRawSchema,
  LogsResponseSchema,
  LokiStreamsSchema,
  MeSchema,
  NetworksSchema,
  MetricRangeSchema,
  MetricsSummarySchema,
  ProjectDetailsResponseSchema,
  ProjectsResponseSchema,
  ReleaseCreatedSchema,
  ReleasesPageSchema,
  ReleaseStatusSchema,
  SourceUploadSchema,
} from '../types';

const DIR = path.join(ROOT_DIR, 'fixtures/liara');

/** fixture id pattern → schema of its body */
const MAP: [RegExp, ZodType][] = [
  [/^01-me$/, MeSchema],
  [/^02a-billing$/, BillingSchema],
  [/^03-projects$/, ProjectsResponseSchema],
  [/^04-networks/, NetworksSchema],
  [/^(05-project|18[aceg]-project.*)$/, ProjectDetailsResponseSchema],
  [/^06-logs-v2-/, LokiStreamsSchema],
  [/^06-logs-v1-/, LogsResponseSchema],
  [/^07[abc]-events-/, EventsRawSchema],
  [/^(08-applets|19b-applets.*|21k-applets.*)$/, AppletsResponseSchema],
  [/^(09-releases|21j-releases.*)$/, ReleasesPageSchema],
  [/^(10-metrics-summary|21e-metrics-summary.*)$/, MetricsSummarySchema],
  [/^11-(cpu|memory|net)-/, MetricRangeSchema],
  [/^(12-domains|22b-domains-list)$/, DomainsResponseSchema],
  [/^13-upload-source$/, SourceUploadSchema],
  [/^(14-deploy-release|20a-release-reuse-source)$/, ReleaseCreatedSchema],
  [/^16a-release-status$/, ReleaseStatusSchema],
  [/^16[bc]-build-logs/, BuildLogsSchema],
  [/^22c-domain-check$/, DomainCheckSchema],
];

interface Fixture {
  status?: number;
  body?: unknown;
}

const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.json') && !f.endsWith('.raw.json')) : [];
const load = (f: string) => JSON.parse(readFileSync(path.join(DIR, f), 'utf8')) as Fixture;
const ok = (fx: Fixture) => typeof fx.status === 'number' && fx.status >= 200 && fx.status < 300;

describe.skipIf(files.length === 0)('probe fixtures parse with client schemas', () => {
  for (const file of files) {
    const id = file.replace(/\.json$/, '');
    const schema = MAP.find(([re]) => re.test(id))?.[1];
    if (!schema) continue;
    it(`${id}`, () => {
      const fx = load(file);
      if (!ok(fx)) return; // non-2xx responses document errors; nothing to parse
      const parsed = schema.safeParse(fx.body);
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
    });
  }

  it('plan catalogue from /v1/me has plans with RAM', () => {
    const me = files.includes('01-me.json') ? load('01-me.json') : null;
    if (!me || !ok(me)) return;
    const plans = extractProjectPlans(me.body);
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.some((p) => p.ramMB > 0 && p.hourlyPriceIRT !== null)).toBe(true);
  });

  it('events and v2 logs normalize without throwing', () => {
    for (const file of files) {
      const fx = load(file);
      if (!ok(fx)) continue;
      if (/^07[abc]-events-/.test(file)) for (const e of normalizeEvents(fx.body as never)) expect(e.ts).toMatch(/^\d{4}-/);
      if (/^06-logs-v2-/.test(file)) for (const l of parseLokiLogs(fx.body as never)) expect(typeof l.message).toBe('string');
    }
  });
});
