import { describe, expect, it } from 'vitest';
import { evaluateExpr, hasUnresolved, renderTemplate, UNRESOLVED } from '../expr';

const ctx = {
  app: { name: 'shop', scale: 1, lastDeployAgeMinutes: 20, status: 'ACTIVE' },
  metrics: { memory: { pctOfLimit: 96 }, cpu: null },
  logs: { errorLines: 7, stackTraces: ['a'] },
  health: { ok: false, status: 502 },
  plan: { nextUp: 'medium-g2', nextUpLabel: '۱ گیگ رم' },
};

describe('evaluateExpr', () => {
  it.each([
    ['app.lastDeployAgeMinutes < 180', true],
    ['app.scale == 0', false],
    ["app.status == 'ACTIVE' && metrics.memory.pctOfLimit >= 90", true],
    ['health.ok == false || app.scale == 0', true],
    ['!(logs.errorLines > 5)', false],
    ['logs.stackTraces.length > 0', true],
    ['metrics.cpu.max >= 90', false],
    ['metrics.cpu == null', true],
    ['missing.path > 1', false],
    ['(app.scale == 1 && health.status != 200) && logs.errorLines >= 7', true],
  ])('%s → %s', (src, expected) => {
    expect(evaluateExpr(src, ctx)).toBe(expected);
  });

  it('rejects anything that is not an expression', () => {
    expect(() => evaluateExpr('process.exit(1)', ctx)).toThrow();
    expect(() => evaluateExpr('a = 1', ctx)).toThrow();
    expect(() => evaluateExpr("'unterminated", ctx)).toThrow();
  });
});

describe('renderTemplate', () => {
  it('keeps raw values for whole placeholders and interpolates strings', () => {
    expect(renderTemplate({ appName: '{{app.name}}', planID: '{{plan.nextUp}}', n: '{{app.scale}}' }, ctx)).toEqual({ appName: 'shop', planID: 'medium-g2', n: 1 });
    expect(renderTemplate('ارتقا به {{plan.nextUpLabel}}', ctx)).toBe('ارتقا به ۱ گیگ رم');
  });

  it('marks missing values as unresolved', () => {
    const r = renderTemplate({ appName: '{{app.name}}', sourceID: '{{source.latest}}' }, ctx);
    expect((r as Record<string, unknown>).sourceID).toBe(UNRESOLVED);
    expect(hasUnresolved(r)).toBe(true);
    expect(hasUnresolved(renderTemplate({ set: { '{{derived.key}}': 'x' } }, ctx))).toBe(true);
  });
});
