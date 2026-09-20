-- ════════════════════════════════════════════════════════════════════
-- 003 — bin_shortfall: correct package counting + access
--
-- Two bugs fixed here:
--
-- 1. expected_packages counted STOPS, not PACKAGES.
--    jsonb_array_length(surge_stops) returns the number of delivery stops.
--    A business receiving 5 packages is ONE stop with FIVE physical
--    packages. PathIQ must expect all five to be stowed before the route
--    is ready. Counting stops meant a route could be marked staged with
--    packages still sitting on the floor.
--
--    SmartSort now writes a pkgs[] array inside every stop, so the real
--    expected count is the sum of those arrays, with a fallback to the
--    stop's own `packages` integer for routes built before that change.
--
-- 2. The view returned 401 to the anon/publishable role.
--    Views do not inherit the grants of their base tables. jobs and
--    packages are readable, but bin_shortfall itself was never granted,
--    so every dispatcher poll failed and the PathIQ shortfall panel was
--    dead. security_invoker keeps the caller's RLS in force rather than
--    the view owner's, so this does not widen access to the base tables.
-- ════════════════════════════════════════════════════════════════════

drop view if exists bin_shortfall;

create view bin_shortfall
with (security_invoker = true)
as
select
  j.org_id,
  j.id                          as job_id,
  j.title,
  j.bin_label                   as bin,

  -- Count actual physical packages across all stops on the route.
  -- Prefers the pkgs[] array; falls back to the stop's packages integer;
  -- finally falls back to 1 per stop for the oldest route records.
  coalesce((
    select sum(
      greatest(
        coalesce(jsonb_array_length(
          case jsonb_typeof(stop->'pkgs')
            when 'array' then stop->'pkgs'
            else '[]'::jsonb
          end
        ), 0),
        coalesce((stop->>'packages')::int, 0),
        1
      )
    )
    from jsonb_array_elements(
      case jsonb_typeof(j.surge_stops)
        when 'array' then j.surge_stops
        else '[]'::jsonb
      end
    ) as stop
  ), 0)::int                    as expected_packages,

  -- Distinct delivery stops on the route — reported separately because
  -- stops and packages are different objects and both matter.
  coalesce(jsonb_array_length(
    case jsonb_typeof(j.surge_stops)
      when 'array' then j.surge_stops
      else '[]'::jsonb
    end
  ), 0)                         as expected_stops,

  count(p.id) filter (where p.current_state in ('stowed','staged','loaded')) as stowed_packages,
  count(p.id) filter (where p.current_state = 'problem')                     as in_problem

from jobs j
left join packages p on p.current_job_id = j.id
where j.status in ('pending','assigned','in_transit')
group by j.org_id, j.id, j.title, j.bin_label, j.surge_stops;

-- The dispatcher polls this with the publishable (anon) key.
-- security_invoker above means the caller's own RLS still applies to
-- jobs and packages; this grant only makes the view itself selectable.
grant select on bin_shortfall to anon, authenticated;
