-- The numbers, from the reports table: `pnpm numbers` (README.md).
-- Every count in a report is rounded down to one significant digit, so sums are "at least".

-- 1. Gateways and people, day by day (the last 30 days).
SELECT day,
       count(*) AS gateways_reporting,
       sum(active_members_1d >= 1) AS gateways_used_that_day,
       sum(members) AS members_at_least,
       sum(active_members_1d) AS active_members_at_least
FROM reports
WHERE day >= date('now', '-30 days')
GROUP BY day
ORDER BY day DESC;

-- 2. The last 7 days as one line: how many Gateways are alive, how many are used, how many
--    have two or more active people, and how many people.
WITH latest AS (
  SELECT r.* FROM reports r
  JOIN (SELECT install, max(day) AS day FROM reports WHERE day >= date('now', '-7 days') GROUP BY install) l
    ON l.install = r.install AND l.day = r.day
)
SELECT count(*) AS gateways_alive_7d,
       sum(active_members_7d >= 1) AS gateways_used_7d,
       sum(active_members_7d >= 2) AS team_gateways_7d,
       sum(members) AS members_at_least,
       sum(active_members_7d) AS active_members_7d_at_least
FROM latest;

-- 3. Which apps are used: Gateways and people per app, per day (the last 14 days). "other" is
--    the operator's own apps together; MCP servers are in 4, not here.
SELECT r.day,
       json_extract(u.value, '$.app') AS app,
       count(*) AS gateways,
       sum(json_extract(u.value, '$.active_members')) AS active_members_at_least,
       sum(json_extract(u.value, '$.tool_calls')) AS tool_calls_at_least
FROM reports r, json_each(r.app_use_1d) u
WHERE r.day >= date('now', '-14 days')
GROUP BY r.day, app
ORDER BY r.day DESC, gateways DESC;

-- 4. MCP servers: Gateways with one connected, how many are connected, and their use, per day
--    (the last 14 days).
SELECT day,
       sum(mcp_servers >= 1) AS gateways_with_mcp_servers,
       sum(mcp_servers) AS mcp_servers_at_least,
       sum(mcp_tool_calls_1d >= 1) AS gateways_using_them,
       sum(mcp_active_members_1d) AS active_members_at_least,
       sum(mcp_tool_calls_1d) AS tool_calls_at_least
FROM reports
WHERE day >= date('now', '-14 days')
GROUP BY day
ORDER BY day DESC;

-- 5. MCP servers per Gateway (each Gateway's latest report in the last 7 days).
SELECT r.mcp_servers, count(*) AS gateways
FROM reports r
JOIN (SELECT install, max(day) AS day FROM reports WHERE day >= date('now', '-7 days') GROUP BY install) l
  ON l.install = r.install AND l.day = r.day
GROUP BY r.mcp_servers
ORDER BY r.mcp_servers;

-- 6. Versions in use (each Gateway's latest report in the last 7 days).
SELECT version, count(DISTINCT install) AS gateways
FROM reports
WHERE day >= date('now', '-7 days')
GROUP BY version
ORDER BY gateways DESC;

-- 7. New Gateways by the month they were set up.
SELECT installed, count(DISTINCT install) AS gateways
FROM reports
GROUP BY installed
ORDER BY installed DESC;
