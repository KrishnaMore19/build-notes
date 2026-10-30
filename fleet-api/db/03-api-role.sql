-- The API connects as a login role that holds nothing itself; it gets exactly
-- what schema.sql granted to `authenticated` (read tables + set_alert_state).
create role fleet_api login password 'fleet_api';
grant authenticated to fleet_api;
