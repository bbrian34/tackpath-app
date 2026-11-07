-- Migration 71: deliveries from Keel arrive in the dispatcher by themselves.
-- Keel (signed in as the company, like the dispatcher) puts each delivery's
-- SmartSort file in the company's inbox (tp_org 'inbox_put'). The dispatcher,
-- while open, claims each new file once (tp_org 'inbox_claim') and imports it
-- into SmartSort exactly as if it had been uploaded. Two dispatcher screens
-- never import the same file twice: the claim is atomic.
-- Additive: one table; tp_org gains three actions, everything else unchanged.
begin;
do $pre$ begin
  if to_regprocedure('tp_sec.tp_org_v69(text,text,jsonb)') is null then raise exception 'Migration 70 is not applied. Nothing was changed.'; end if;
  if to_regclass('public.smartsort_inbox') is not null then raise exception 'Migration 71 is already applied. Nothing was changed.'; end if;
end $pre$;

create table public.smartsort_inbox (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null,
  ref         text not null,
  filename    text,
  csv         text not null,
  created_at  timestamptz not null default now(),
  claimed_at  timestamptz,
  claimed_by  text,
  unique (org_id, ref)
);
alter table public.smartsort_inbox enable row level security;
revoke all on public.smartsort_inbox from public, anon, authenticated;

alter function public.tp_org(text,text,jsonb) rename to tp_org_v70;
alter function public.tp_org_v70(text,text,jsonb) set schema tp_sec;
revoke all on function tp_sec.tp_org_v70(text,text,jsonb) from public, anon, authenticated;

create function public.tp_org(p_token text, p_action text, p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a jsonb := coalesce(p_args, '{}'); s tp_sec.sessions; org text; res jsonb; r public.smartsort_inbox;
begin
  if p_action not in ('inbox_put', 'inbox', 'inbox_claim') then
    return tp_sec.tp_org_v70(p_token, p_action, p_args);
  end if;
  s := tp_sec.session(p_token, 'org');
  org := s.org_key;

  if p_action = 'inbox_put' then      -- Keel hands over a delivery; the same reference twice is a no-op
    if coalesce(a->>'ref', '') = '' or coalesce(a->>'csv', '') = '' then raise exception 'TP_INVALID: ref and csv are required'; end if;
    if length(a->>'csv') > 200000 then raise exception 'TP_INVALID: file too large'; end if;
    insert into public.smartsort_inbox (org_id, ref, filename, csv)
    values (org::uuid, left(a->>'ref', 120), left(a->>'filename', 200), a->>'csv')
    on conflict (org_id, ref) do nothing returning * into r;
    return jsonb_build_object('ok', true, 'new', r.id is not null);
  end if;

  if p_action = 'inbox' then          -- files waiting for this company's dispatcher (without their contents)
    select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'ref', i.ref, 'filename', i.filename, 'created_at', i.created_at) order by i.created_at), '[]')
      into res from public.smartsort_inbox i where i.org_id::text = org and i.claimed_at is null;
    return res;
  end if;

  if p_action = 'inbox_claim' then    -- one dispatcher screen takes the file; everyone else gets nothing
    update public.smartsort_inbox set claimed_at = now(), claimed_by = left(coalesce(a->>'by', 'dispatcher'), 120)
     where id::text = a->>'id' and org_id::text = org and claimed_at is null returning * into r;
    if r.id is null then return jsonb_build_object('ok', false); end if;
    return jsonb_build_object('ok', true, 'ref', r.ref, 'filename', r.filename, 'csv', r.csv);
  end if;
  return '{}'::jsonb;
end $$;
revoke all on function public.tp_org(text,text,jsonb) from public;
grant execute on function public.tp_org(text,text,jsonb) to anon, authenticated, service_role;

commit;
