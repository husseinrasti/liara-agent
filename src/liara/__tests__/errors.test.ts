import { describe, expect, it } from 'vitest';
import { userMessageFor } from '../errors';

describe('userMessageFor', () => {
  it('explains the daily deploy cap instead of an unexpected error [live 428]', () => {
    expect(userMessageFor(428, undefined, 'Max deployment count in day.')).toMatch(/سقف تعداد انتشار روزانه/);
    expect(userMessageFor(428, undefined, 'something else')).toMatch(/غیرمنتظره/);
  });
});
