import { describe, expect, it } from 'vitest';
import { fakeAgent } from '../../test-utils/fake-agent';
import { scriptedTextModel } from '../../test-utils/mock-model';
import { AgentSession, estimateTokens } from '../session';

describe('AgentSession', () => {
  it('persists merged text deltas and replays events in order', () => {
    const { rt } = fakeAgent({});
    const s = AgentSession.create(rt, { appName: 'shop' });
    s.emit({ type: 'tool_start', callId: 'c1', tool: 'get_app', argsSummary: 'x', risk: 0 });
    s.emit({ type: 'assistant_text_delta', delta: 'سلام ' });
    s.emit({ type: 'assistant_text_delta', delta: 'دنیا' });
    s.emit({ type: 'done' });
    const replay = AgentSession.load(rt, s.id)!.replay();
    expect(replay.map((e) => e.type)).toEqual(['tool_start', 'assistant_text_delta', 'done']);
    expect(replay[1]).toMatchObject({ delta: 'سلام دنیا' });
  });

  it('reloads history and tracks the selected app on the bus', () => {
    const { rt } = fakeAgent({});
    const s = AgentSession.create(rt);
    s.appendMessages([
      { role: 'user', content: 'سلام' },
      { role: 'assistant', content: 'درود' },
    ]);
    s.setApp('shop');
    const again = AgentSession.load(rt, s.id)!;
    expect(again.history).toHaveLength(2);
    expect(again.appName).toBe('shop');
    expect(rt.bus.sessionsForApp('shop')).toContain(s.id);
  });

  it('compacts long histories into a summary, keeping recent messages intact', async () => {
    const { rt } = fakeAgent({ fast: scriptedTextModel(['- کاربر سرویس shop را دیپلوی کرد\n- رم کم بود']) });
    const s = AgentSession.create(rt);
    const big = 'x'.repeat(4000);
    for (let i = 0; i < 30; i++) s.appendMessages([{ role: 'user', content: `${i} ${big}` }, { role: 'assistant', content: `ok ${i}` }]);
    expect(estimateTokens(s.history)).toBeGreaterThan(24_000);
    expect(await s.compactIfNeeded()).toBe(true);
    expect(s.history.length).toBeLessThanOrEqual(21);
    expect(s.history[0]!.role).toBe('user');
    expect(s.summary).toContain('shop');
    const reloaded = AgentSession.load(rt, s.id)!;
    expect(reloaded.summary).toBe(s.summary);
    expect(reloaded.history).toHaveLength(s.history.length);
  });
});
