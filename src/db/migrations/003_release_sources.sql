-- One source can back several releases (a rollback re-releases an older source),
-- so release → source lives in its own table; sources.releaseID keeps the latest.
CREATE TABLE IF NOT EXISTS release_sources (
  appName TEXT NOT NULL,
  releaseID TEXT NOT NULL,
  sourceID TEXT NOT NULL,
  PRIMARY KEY (appName, releaseID)
);
INSERT OR IGNORE INTO release_sources (appName, releaseID, sourceID)
  SELECT appName, releaseID, sourceID FROM sources WHERE releaseID IS NOT NULL;
