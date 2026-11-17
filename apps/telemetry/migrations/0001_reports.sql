-- One row per Gateway per day: the report as it was sent, and nothing else. No address, no
-- header, no time finer than the day.
CREATE TABLE reports (
  install TEXT NOT NULL,
  day TEXT NOT NULL,
  version TEXT NOT NULL,
  installed TEXT NOT NULL,
  members INTEGER NOT NULL,
  active_members_1d INTEGER NOT NULL,
  active_members_7d INTEGER NOT NULL,
  apps INTEGER NOT NULL,
  -- JSON: [{ "app": "openseo", "active_members": 3, "tool_calls": 40 }, …]
  app_use_1d TEXT NOT NULL,
  PRIMARY KEY (install, day)
) WITHOUT ROWID;

CREATE INDEX reports_day_idx ON reports (day);
