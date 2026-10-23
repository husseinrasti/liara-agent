-- Alerts closed because the app recovered or a fix was verified. Unlike a user's
-- acknowledgement, a resolved alert does not suppress a new alert for the same problem.
ALTER TABLE alerts ADD COLUMN resolvedAt TEXT;
