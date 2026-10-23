import { describe, expect, it } from 'vitest';
import { openDb } from '../index';
import { badReleases, linkSourceRelease, markReleaseBad, recordSource, sourceForRelease } from '../repo';

describe('sources and releases', () => {
  it('finds the source of every release that used it, including a rollback re-release', () => {
    const db = openDb(':memory:');
    recordSource(db, { appName: 'shop', sourceID: 's1', archivePath: '/data/sources/shop/a.tar.gz', createdAt: '2026-10-22T10:00:00Z' });
    linkSourceRelease(db, 'shop', 's1', 'r1');
    linkSourceRelease(db, 'shop', 's1', 'r3');
    expect(sourceForRelease(db, 'shop', 'r1')).toMatchObject({ sourceID: 's1', releaseID: 'r1', archivePath: '/data/sources/shop/a.tar.gz' });
    expect(sourceForRelease(db, 'shop', 'r3')).toMatchObject({ sourceID: 's1', releaseID: 'r3' });
    expect(sourceForRelease(db, 'shop', 'r2')).toBeUndefined();
    expect(sourceForRelease(db, 'blog', 'r1')).toBeUndefined();
  });

  it('remembers releases we rolled back from, once each', () => {
    const db = openDb(':memory:');
    markReleaseBad(db, 'shop', 'r2');
    markReleaseBad(db, 'shop', 'r2');
    markReleaseBad(db, 'shop', 'r4');
    expect(badReleases(db, 'shop')).toEqual(['r2', 'r4']);
    expect(badReleases(db, 'blog')).toEqual([]);
  });
});
