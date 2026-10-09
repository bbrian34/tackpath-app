-- ═══════════════════════════════════════════════════════════════════════
-- TackPath: Google Play / App Store reviewer account (run after migration 10)
--
-- Creates (if missing) the review company "tackpath-review" and its one
-- driver, "App Review Driver", on the fictional number +1 (404) 555-0199
-- (555-01xx numbers are reserved for fiction: no real person can receive
-- texts there, and TackPath never texts it).
--
-- The reviewer signs in with that number and a FIXED 6-digit code that works
-- for that number only and only ever shows the review company's jobs. The
-- code itself is not in this repository: choose one and set it with
--     select tp_sec.admin_set_demo_code('NNNNNN');
-- then put the number and code in Play Console / App Store Connect review
-- notes. Setting a new code signs the reviewer out.
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $$
declare org text;
begin
  select id::text into org from public.organizations where slug = 'tackpath-review';
  if org is null then
    perform tp_sec.insert_json('public.organizations',
      jsonb_build_object('name', 'TackPath Review', 'slug', 'tackpath-review'), array['name','slug']);
    select id::text into org from public.organizations where slug = 'tackpath-review';
  end if;
  if not exists (select 1 from public.drivers d where tp_sec.norm_phone(d.phone) = '4045550199') then
    perform tp_sec.insert_json('public.drivers',
      jsonb_build_object('name', 'App Review Driver', 'phone', '4045550199', 'sms_consent', false,
                         'status', 'active', 'org_id', org),
      array['name','phone','sms_consent','status','org_id']);
  end if;
end $$;

commit;

-- Then, for a working demo, sign in to the dispatcher as tackpath-review
-- (set its company code first: select tp_sec.admin_set_org_code('tackpath-review', '...'))
-- and create a short demo route with 2-3 stops near a public address.
