import { describe, expect, it } from 'vitest';
import { LiaraClient } from '../client';
import { getBalance } from '../endpoints/account';
import { resolveNetwork } from '../endpoints/networks';
import { fakeClient, fakeFetch, type FakeCall } from '../../test-utils/fake-liara';

/** Real /v1/billing shape in team mode [probe]: the team holds the money, user.balance is 0. */
const billing = { body: { user: { balance: 0, accountType: 'REAL_PERSON' }, team: { balance: 3_757_112.3, accountType: 'REAL_PERSON' } } };

describe('getBalance', () => {
  it('uses the team balance in team mode and the user balance otherwise', async () => {
    const team = new LiaraClient({ token: 'test-token-not-real', teamId: 't1', fetch: fakeFetch({ 'GET /v1/billing': billing }), sleep: async () => {} });
    expect(await getBalance(team)).toMatchObject({ known: true, amountIRT: 3_757_112.3 });
    expect(await getBalance(fakeClient({ 'GET /v1/billing': billing }))).toMatchObject({ known: true, amountIRT: 0 });
  });
});

describe('resolveNetwork', () => {
  it('uses the first existing network', async () => {
    const calls: FakeCall[] = [];
    const net = await resolveNetwork(fakeClient({ 'GET /v1/networks': { body: { networks: [{ _id: 'n1', name: 'my-network' }] } } }, calls));
    expect(net).toEqual({ _id: 'n1', name: 'my-network', created: false });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('creates a "liara-agent" network when there is none', async () => {
    const networks: { _id: string; name: string }[] = [];
    const calls: FakeCall[] = [];
    const c = fakeClient(
      {
        'GET /v1/networks': () => ({ body: { networks } }),
        'POST /v1/networks': (call: { body?: unknown }) => (networks.push({ _id: 'n2', name: (call.body as { networkName: string }).networkName }), { body: {} }),
      },
      calls,
    );
    expect(await resolveNetwork(c)).toEqual({ _id: 'n2', name: 'liara-agent', created: true });
    expect(calls.find((x) => x.method === 'POST')?.body).toEqual({ networkName: 'liara-agent' });
  });
});
