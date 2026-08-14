create table if not exists shopify_connections (
  id uuid default gen_random_uuid() primary key,
  org_id uuid references organizations(id),
  shop_domain text not null unique,
  access_token text not null,
  scope text,
  installed_at timestamptz default now(),
  active boolean default true,
  delivery_method text default 'same_day',
  auto_dispatch boolean default true
);

create index if not exists idx_shopify_shop_domain on shopify_connections(shop_domain);
create index if not exists idx_shopify_org_id on shopify_connections(org_id);

alter table jobs add column if not exists shopify_order_id text;
alter table jobs add column if not exists shopify_fulfillment_order_id text;
alter table jobs add column if not exists source text default 'manual';

create index if not exists idx_jobs_shopify_fulfillment on jobs(shopify_fulfillment_order_id);

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on shopify_connections to anon, authenticated, service_role;
