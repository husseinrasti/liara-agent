import { describe, expect, it } from 'vitest';
import { dnsTargetOf } from '../../liara/endpoints/domains';
import { dnsRecords, dnsStepsFa, domainStatusFa } from '../liara/domains';

const node = { host: 'sabalan.liara.cloud', ip: '185.208.180.12' };

describe('domain guidance', () => {
  it('reads the DNS target from the check response, not CNameRecord (a status) [probe 22c]', () => {
    const check = { name: 'myshop.ir', status: 'PENDING', CNameRecord: 'INVALID', project: { _id: 'p1', network: { node: { host: 'sabalan.liara.cloud', IP: '185.208.180.12' } } } };
    expect(dnsTargetOf(check)).toEqual(node);
    expect(dnsTargetOf({ CNameRecord: 'INVALID' })).toEqual({ host: null, ip: null });
  });

  it('apex: A record to the node IP plus a www CNAME; subdomain: one CNAME to the node host', () => {
    expect(dnsRecords('myshop.ir', node)).toEqual([
      { type: 'A', name: '@', value: '185.208.180.12' },
      { type: 'CNAME', name: 'www', value: 'sabalan.liara.cloud' },
    ]);
    expect(dnsRecords('myshop.ir', { host: 'sabalan.liara.cloud', ip: null })[0]).toEqual({ type: 'ALIAS / ANAME', name: '@', value: 'sabalan.liara.cloud' });
    expect(dnsRecords('api.myshop.ir', node)).toEqual([{ type: 'CNAME', name: 'api', value: 'sabalan.liara.cloud' }]);
    expect(dnsRecords('myshop.ir', { host: null, ip: null })).toEqual([]);
  });

  it('.ir domains get IRNIC steps; others the registrar panel', () => {
    expect(dnsStepsFa('myshop.ir', node)[0]).toContain('irnic.ir');
    expect(dnsStepsFa('myshop.ir', node).join(' ')).toContain('185.208.180.12');
    expect(dnsStepsFa('myshop.com', node)[0]).toContain('پنل');
    expect(dnsStepsFa('myshop.com', node).at(-1)).toContain('هر دقیقه');
  });

  it('shows domain states in Persian', () => {
    expect(domainStatusFa('PENDING')).toBe('در انتظار تنظیم DNS');
    expect(domainStatusFa(undefined)).toBe('نامشخص');
  });
});
