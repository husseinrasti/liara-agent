import { describe, expect, it } from 'vitest';
import { sanitize, sanitizeString } from './sanitize';

describe('sanitize', () => {
  it('removes personal data and credentials but keeps structure and app ids', () => {
    const raw = {
      user: { _id: 'u123', email: 'a@b.ir', phone: '09121234567', fullname: 'Ali', storage: { secretKey: 'S', accessKey: 'A' } },
      project: { _id: 'p1', project_id: 'my-app', envs: [{ key: 'DB_PASSWORD', value: 'hunter2' }, { key: 'PROBE_KEY', value: '1' }] },
      domain: { user: 'u123', verificationCode: 'abc', name: 'example.ir' },
      note: 'call 09121234567 or mail x@y.com, token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk from 10.1.2.3',
    };
    const out = sanitize(raw) as typeof raw;
    expect(out.user._id).toBe('<user-id>');
    expect(out.user.email).toBe('user@example.com');
    expect(out.user.phone).toBe('09000000000');
    expect(out.user.storage.secretKey).toBe('<secret-key>');
    expect(out.project._id).toBe('p1');
    expect(out.project.project_id).toBe('my-app');
    expect(out.project.envs[0]).toEqual({ key: 'DB_PASSWORD', value: '<redacted>' });
    expect(out.project.envs[1]).toEqual({ key: 'PROBE_KEY', value: '1' });
    expect(out.domain.user).toBe('<user-id>');
    expect(out.domain.name).toBe('example.ir');
    const s = JSON.stringify(out);
    for (const leaked of ['a@b.ir', '09121234567', 'hunter2', 'u123', 'eyJhbGci', '10.1.2.3', 'Ali']) {
      expect(s).not.toContain(leaked);
    }
  });

  it('scrubs bearer tokens in free text', () => {
    expect(sanitizeString('Authorization: Bearer abc.def.ghi')).toBe('Authorization: Bearer <token>');
  });
});
