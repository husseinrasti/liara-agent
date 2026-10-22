import { describe, expect, it } from 'vitest';
import { fakeClient, type FakeCall } from '../../test-utils/fake-liara';
import { deleteEnvs, EncryptedEnvError, mergeEnvs, updateEnvs } from '../endpoints/envs';

describe('mergeEnvs', () => {
  const current = [
    { key: 'A', value: '1' },
    { key: 'B', value: '2' },
  ];
  it('adds and overwrites while keeping the rest', () => {
    expect(mergeEnvs(current, { B: '20', C: '3' })).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: '20' },
      { key: 'C', value: '3' },
    ]);
  });
  it('removes unset keys', () => {
    expect(mergeEnvs(current, {}, ['A'])).toEqual([{ key: 'B', value: '2' }]);
  });
  it('refuses to re-send encrypted values it cannot read', () => {
    expect(() => mergeEnvs([{ key: 'S', encrypted: true, value: null }], { X: '1' })).toThrow(EncryptedEnvError);
  });
});

describe('updateEnvs / deleteEnvs (full-set semantics)', () => {
  function client(calls: FakeCall[]) {
    return fakeClient(
      {
        'GET /v1/projects/app': { body: { project: { _id: 'p', project_id: 'app', type: 'node', envs: [{ key: 'KEEP', value: 'k' }, { key: 'OLD', value: 'o' }] } } },
        'POST /v1/projects/update-envs': { body: {} },
      },
      calls,
    );
  }

  it('sends the merged full set to update-envs', async () => {
    const calls: FakeCall[] = [];
    const keys = await updateEnvs(client(calls), 'app', { NEW: 'n' }, ['OLD']);
    expect(keys).toEqual(['KEEP', 'NEW']);
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ project: 'app', variables: [{ key: 'KEEP', value: 'k' }, { key: 'NEW', value: 'n' }] });
  });

  it('deleteEnvs keeps the others', async () => {
    const calls: FakeCall[] = [];
    await deleteEnvs(client(calls), 'app', ['KEEP']);
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ project: 'app', variables: [{ key: 'OLD', value: 'o' }] });
  });
});
