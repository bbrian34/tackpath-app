-- ════════════════════════════════════════════════════════════════════
-- 004 — PathIQ bin registry
--
-- A bin is a movable physical container in the warehouse. It is not a
-- property of a route and SmartSort does not assign it. The worker
-- discovers which bin holds which route by opening one during stow:
--
--   scan package → route resolved → no open bin for that route?
--     → OPEN BIN → scan bin QR → scan location QR → bin is bound
--     → rescan the package to confirm custody
--
-- Once bound, the bin stays bound to that route until the driver picks
-- it up. Every later package for the same route routes straight to it.
--
-- Object separation this enforces:
--   package  ≠ stop ≠ route ≠ bin ≠ location
--   a bin moves between locations and keeps its own id
-- ════════════════════════════════════════════════════════════════════

create table if not exists bin_bindings (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid,

  -- The physical container, as printed on its QR label (e.g. "1A", "C-07")
  bin_code     text not null,

  -- Where that container is currently sitting, from the location QR
  location_code text,

  -- The route this bin currently holds
  job_id       uuid references jobs(id) on delete cascade,

  -- open      → bound, worker is stowing into it
  -- ready     → every expected package stowed, awaiting driver
  -- released  → driver picked it up, bin is free again
  state        text not null default 'open',

  opened_by    text,
  opened_at    timestamptz not null default now(),
  ready_at     timestamptz,
  released_at  timestamptz
);

-- A physical bin can hold only one route at a time. Partial unique index
-- so released bins can be reused without violating the constraint.
create unique index if not exists bin_bindings_one_live_per_bin
  on bin_bindings (org_id, bin_code)
  where state in ('open','ready');

-- A route can occupy only one bin at a time.
create unique index if not exists bin_bindings_one_live_per_job
  on bin_bindings (job_id)
  where state in ('open','ready');

create index if not exists bin_bindings_job_idx on bin_bindings(job_id);
create index if not exists bin_bindings_state_idx on bin_bindings(org_id, state);

alter table bin_bindings enable row level security;

drop policy if exists bin_bindings_rw on bin_bindings;
create policy bin_bindings_rw on bin_bindings for all
  using (true) with check (true);

grant select, insert, update, delete on bin_bindings to anon, authenticated;

-- ── bin_shortfall now reads the bin from the binding, not from jobs ──
-- jobs.bin_label is no longer written by SmartSort. A route with no
-- binding yet simply has no bin, which is the correct state before stow.
drop view if exists bin_shortfall;

create view bin_shortfall as
select
  j.org_id,
  j.id                          as job_id,
  j.title,
  b.bin_code                    as bin,
  b.location_code               as location,
  b.state                       as bin_state,
  coalesce((
    select sum(
      greatest(
        coalesce(jsonb_array_length(
          case jsonb_typeof(stop->'pkgs')
            when 'array' then stop->'pkgs' else '[]'::jsonb end
        ), 0),
        coalesce((stop->>'packages')::int, 0),
        1
      )
    )
    from jsonb_array_elements(
      case jsonb_typeof(j.surge_stops)
        when 'array' then j.surge_stops else '[]'::jsonb end
    ) as stop
  ), 0)::int                    as expected_packages,
  coalesce(jsonb_array_length(
    case jsonb_typeof(j.surge_stops)
      when 'array' then j.surge_stops else '[]'::jsonb end
  ), 0)                         as expected_stops,
  count(p.id) filter (where p.current_state in ('stowed','staged','loaded')) as stowed_packages,
  count(p.id) filter (where p.current_state = 'problem')                     as in_problem
from jobs j
left join packages p on p.current_job_id = j.id
left join bin_bindings b on b.job_id = j.id and b.state in ('open','ready')
where j.status in ('pending','assigned','in_transit')
group by j.org_id, j.id, j.title, j.surge_stops, b.bin_code, b.location_code, b.state;

grant select on bin_shortfall to anon, authenticated;
