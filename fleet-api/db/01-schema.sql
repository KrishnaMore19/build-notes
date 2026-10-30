-- =============================================================================
-- Fleet operations console: schema, constraints, indexes, RLS and grants.
--
-- Run once on an empty Supabase project (SQL editor, as the postgres role),
-- then run db/seed.sql. Safe to read top to bottom: every decision is commented.
--
-- Stored vs derived
--   stored   vehicles.last_*           last-known snapshot, so the map loads from one table
--   stored   trips.<summary columns>   immutable summary of a finished trip, so lists never load GPS points
--   derived  vehicle status            computed on read (src/features/vehicles/status.ts); a stored
--                                      column would go stale the moment a tracker stops reporting
--   derived  halts / overspeed events  computed from trip_points by src/features/trips/analysis.ts, the
--                                      same function that produced the stored summary (single source of truth)
--   derived  remaining distance        changes with every ping
--
-- Delete behaviour
--   trip_points -> trips      CASCADE   points are meaningless without their trip
--   trips -> vehicles         RESTRICT  trip history is an operational record; decommission, do not delete
--   alerts -> vehicles        RESTRICT  same reason
--   alerts -> trips           SET NULL  an alert outlives pruning of old trips
--   vehicles/trips -> drivers SET NULL  removing a driver (for example an erasure request) must not delete history
--   *_by columns -> auth.users SET NULL removing an operator account keeps the alert history
-- =============================================================================

create table public.depots (
  id    uuid primary key,
  name  text not null,
  city  text not null,
  lat   double precision not null check (lat between -90 and 90),
  lng   double precision not null check (lng between -180 and 180)
);

create table public.drivers (
  id            uuid primary key,
  full_name     text not null,
  employee_code text not null unique
);

-- Personal data is kept out of `drivers` so the console cannot read it by accident.
-- No policy and no grant exist for this table: it is reachable only by the table owner.
create table public.driver_contacts (
  driver_id uuid primary key references public.drivers (id) on delete cascade,
  phone     text not null
);

create table public.vehicles (
  id               uuid primary key,
  registration     text not null unique,
  make_model       text not null,
  depot_id         uuid not null references public.depots (id) on delete restrict,
  driver_id        uuid references public.drivers (id) on delete set null,
  -- Fleet policy limit for this vehicle (not the posted road limit).
  speed_limit_kmph smallint not null check (speed_limit_kmph between 20 and 140),
  odometer_km      numeric(10, 1) not null check (odometer_km >= 0),

  -- Last-known snapshot. Nullable: a newly provisioned vehicle may never have reported.
  last_lat         double precision check (last_lat between -90 and 90),
  last_lng         double precision check (last_lng between -180 and 180),
  last_speed_kmph  numeric(5, 1) check (last_speed_kmph between 0 and 250),
  last_heading_deg smallint check (last_heading_deg between 0 and 359),
  fuel_pct         smallint check (fuel_pct between 0 and 100),
  battery_pct      smallint check (battery_pct between 0 and 100),
  ignition         boolean not null default false,
  last_seen_at     timestamptz,

  constraint vehicles_position_pair check ((last_lat is null) = (last_lng is null))
);
create index vehicles_depot_id_idx  on public.vehicles (depot_id);   -- supports the RESTRICT check and depot filters
create index vehicles_driver_id_idx on public.vehicles (driver_id);  -- supports SET NULL on driver removal

create table public.trips (
  id               uuid primary key,
  vehicle_id       uuid not null references public.vehicles (id) on delete restrict,
  driver_id        uuid references public.drivers (id) on delete set null,
  status           text not null check (status in ('in_progress', 'completed')),
  started_at       timestamptz not null,
  ended_at         timestamptz,
  start_label      text not null,
  end_label        text not null,
  dest_lat         double precision not null check (dest_lat between -90 and 90),
  dest_lng         double precision not null check (dest_lng between -180 and 180),
  -- The limit in force for this trip. Stored with the summary so the overspeed count can
  -- never drift if the vehicle's policy limit changes later.
  speed_limit_kmph smallint not null check (speed_limit_kmph between 20 and 140),

  -- Immutable summary, written once when a trip completes. Null while in progress.
  distance_km      numeric(8, 2),
  duration_s       integer,
  avg_speed_kmph   numeric(5, 1),
  max_speed_kmph   numeric(5, 1),
  idle_s           integer,
  halt_count       smallint,
  overspeed_count  smallint,

  constraint trips_time_order check (ended_at is null or ended_at > started_at),
  constraint trips_summary_shape check (
    (status = 'in_progress'
       and ended_at is null
       and distance_km is null and duration_s is null and avg_speed_kmph is null
       and max_speed_kmph is null and idle_s is null and halt_count is null and overspeed_count is null)
    or
    (status = 'completed'
       and ended_at is not null
       and distance_km >= 0 and duration_s >= 0 and avg_speed_kmph >= 0
       and max_speed_kmph >= 0 and idle_s >= 0 and halt_count >= 0 and overspeed_count >= 0)
  )
);
-- Recent trips for one vehicle, newest first.
create index trips_vehicle_started_idx on public.trips (vehicle_id, started_at desc);
-- Domain invariant: a vehicle can have at most one trip in progress.
create unique index trips_one_active_per_vehicle on public.trips (vehicle_id) where status = 'in_progress';
create index trips_driver_id_idx on public.trips (driver_id);

create table public.trip_points (
  trip_id     uuid not null references public.trips (id) on delete cascade,
  seq         integer not null check (seq >= 0),
  recorded_at timestamptz not null,
  lat         double precision not null check (lat between -90 and 90),
  lng         double precision not null check (lng between -180 and 180),
  speed_kmph  numeric(5, 1) not null check (speed_kmph between 0 and 250),
  ignition    boolean not null,
  -- The primary key is also the only access path: all points of one trip, in order.
  primary key (trip_id, seq)
);

create table public.alerts (
  id              uuid primary key,
  vehicle_id      uuid not null references public.vehicles (id) on delete restrict,
  trip_id         uuid references public.trips (id) on delete set null,
  kind            text not null check (kind in ('overspeed', 'low_fuel', 'low_battery', 'extended_idle', 'signal_lost')),
  severity        text not null check (severity in ('critical', 'warning', 'info')),
  message         text not null,
  opened_at       timestamptz not null,
  state           text not null default 'open' check (state in ('open', 'acknowledged', 'resolved')),
  acknowledged_by uuid references auth.users (id) on delete set null,
  acknowledged_at timestamptz,
  resolved_by     uuid references auth.users (id) on delete set null,
  resolved_at     timestamptz,
  constraint alerts_state_shape check (
    (state = 'open'         and acknowledged_at is null and resolved_at is null)
    or (state = 'acknowledged' and acknowledged_at is not null and resolved_at is null)
    or (state = 'resolved'     and resolved_at is not null)
  )
);
-- "Needs attention": every unresolved alert. Small, hot, partial.
create index alerts_unresolved_idx on public.alerts (opened_at desc) where state <> 'resolved';
-- Alerts of one vehicle for the detail panel.
create index alerts_vehicle_opened_idx on public.alerts (vehicle_id, opened_at desc);
create index alerts_trip_id_idx on public.alerts (trip_id);

-- =============================================================================
-- Row Level Security: enabled everywhere, deny by default.
--
-- Supabase grants new tables to anon/authenticated/service_role through default
-- privileges, so grants are revoked explicitly and then re-added minimally.
-- Operators are one trusted team: every authenticated user may read everything
-- except driver_contacts. Nobody can write through the API tables directly.
-- =============================================================================

alter table public.depots          enable row level security;
alter table public.drivers         enable row level security;
alter table public.driver_contacts enable row level security;
alter table public.vehicles        enable row level security;
alter table public.trips           enable row level security;
alter table public.trip_points     enable row level security;
alter table public.alerts          enable row level security;

revoke all on public.depots, public.drivers, public.driver_contacts, public.vehicles,
              public.trips, public.trip_points, public.alerts
  from public, anon, authenticated;

grant select on public.depots, public.drivers, public.vehicles,
                public.trips, public.trip_points, public.alerts
  to authenticated;

create policy depots_read      on public.depots      for select to authenticated using (true);
create policy drivers_read     on public.drivers     for select to authenticated using (true);
create policy vehicles_read    on public.vehicles    for select to authenticated using (true);
create policy trips_read       on public.trips       for select to authenticated using (true);
create policy trip_points_read on public.trip_points for select to authenticated using (true);
create policy alerts_read      on public.alerts      for select to authenticated using (true);
-- driver_contacts: intentionally no policy and no grant.

-- =============================================================================
-- The only write path available to the browser: acknowledge or resolve an alert.
--
-- Why an RPC and not a column-level UPDATE grant: the state transition rules
-- (open -> acknowledged -> resolved, open -> resolved) and the audit fields
-- (who, when) must be set together and cannot be forged. A column grant would
-- let a client set resolved_by to someone else or resolve an alert without
-- acknowledged_at. The function runs as its owner, so the clients need no
-- UPDATE privilege at all.
--
-- search_path is empty and every reference is schema-qualified, so a caller
-- cannot shadow functions or tables.
-- =============================================================================

create or replace function public.set_alert_state(p_alert_id uuid, p_action text)
returns public.alerts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.alerts;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_action is null or p_action not in ('acknowledge', 'resolve') then
    raise exception 'unknown action' using errcode = '22023';
  end if;

  select * into v_row from public.alerts where id = p_alert_id for update;
  if not found then
    raise exception 'alert not found' using errcode = 'P0002';
  end if;

  if p_action = 'acknowledge' then
    if v_row.state <> 'open' then
      raise exception 'only an open alert can be acknowledged' using errcode = '55000';
    end if;
    update public.alerts
       set state = 'acknowledged', acknowledged_by = v_uid, acknowledged_at = pg_catalog.now()
     where id = p_alert_id
    returning * into v_row;
  else
    if v_row.state = 'resolved' then
      raise exception 'alert is already resolved' using errcode = '55000';
    end if;
    update public.alerts
       set state = 'resolved', resolved_by = v_uid, resolved_at = pg_catalog.now()
     where id = p_alert_id
    returning * into v_row;
  end if;

  return v_row;
end;
$$;

revoke execute on function public.set_alert_state(uuid, text) from public, anon;
grant  execute on function public.set_alert_state(uuid, text) to authenticated;

-- =============================================================================
-- Administrator utility: re-anchor demo data to the present.
--
-- Seed timestamps are relative to the moment db/seed.sql ran. If the demo sits
-- unused for days, run `select public.shift_seed_to_now();` in the SQL editor
-- (as postgres) and every timestamp moves forward by the same amount, so the
-- newest vehicle ping is 10 seconds old again. The app also shows a banner
-- while data is stale, so a stale demo is never mistaken for live data.
--
-- SECURITY INVOKER on purpose: even if a grant were added by mistake, the
-- caller would still need UPDATE privileges, which the browser roles do not have.
-- Execute is revoked from every API role, so it cannot be called from the browser.
-- =============================================================================

create or replace function public.shift_seed_to_now()
returns interval
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_newest timestamptz;
  v_delta  interval;
begin
  select max(last_seen_at) into v_newest from public.vehicles;
  if v_newest is null then
    raise exception 'no vehicle has reported; nothing to anchor to';
  end if;

  v_delta := (pg_catalog.now() - interval '10 seconds') - v_newest;
  if v_delta <= interval '0' then
    return interval '0';
  end if;

  update public.vehicles    set last_seen_at = last_seen_at + v_delta;
  update public.trips       set started_at = started_at + v_delta,
                                ended_at   = ended_at + v_delta;
  update public.trip_points set recorded_at = recorded_at + v_delta;
  update public.alerts      set opened_at       = opened_at + v_delta,
                                acknowledged_at = acknowledged_at + v_delta,
                                resolved_at     = resolved_at + v_delta;
  return v_delta;
end;
$$;

revoke execute on function public.shift_seed_to_now() from public, anon, authenticated, service_role;
