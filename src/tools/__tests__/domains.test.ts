import { describe, expect, it } from 'vitest';
import { dnsRecords, dnsStepsFa, domainStatusFa } from '../liara/domains';

describe('domain guidance', () => {
  it('apex domains get ALIAS/ANAME plus a www CNAME; subdomains one CNAME', () => {
    expect(dnsRecords('myshop.ir', 'shop.liara.run')).toEqual([
      { type: 'ALIAS / ANAME', name: '@', value: 'shop.liara.run' },
      { type: 'CNAME', name: 'www', value: 'shop.liara.run' },
    ]);
    expect(dnsRecords('api.myshop.ir', 'shop.liara.run')).toEqual([{ type: 'CNAME', name: 'api', value: 'shop.liara.run' }]);
    expect(dnsRecords('myshop.ir', null)).toEqual([]);
  });

  it('.ir domains get IRNIC steps; others the registrar panel', () => {
    expect(dnsStepsFa('myshop.ir', 'shop.liara.run')[0]).toContain('irnic.ir');
    expect(dnsStepsFa('myshop.com', 'shop.liara.run')[0]).toContain('پنل');
    expect(dnsStepsFa('myshop.com', 'shop.liara.run').at(-1)).toContain('هر دقیقه');
  });

  it('shows domain states in Persian', () => {
    expect(domainStatusFa('PENDING')).toBe('در انتظار تنظیم DNS');
    expect(domainStatusFa(undefined)).toBe('نامشخص');
  });
});
