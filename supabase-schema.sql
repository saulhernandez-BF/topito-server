-- Esquema de Topito en Supabase. Pegar en: Supabase → SQL Editor → Run.
-- Es idempotente (se puede correr varias veces).
-- Seguridad: RLS activado SIN políticas → la llave "anon" no puede leer ni
-- escribir nada. Solo el server (service_role key) tiene acceso.

create table if not exists usage_log (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  endpoint text,
  provider text,
  model text,
  input_tokens integer default 0,
  output_tokens integer default 0,
  estimated_cost_usd numeric
);
create index if not exists usage_log_created_at_idx on usage_log (created_at);

create table if not exists feedback (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  brand text,
  source text,          -- reescribir / crear
  rating text check (rating in ('like','neutral','bad')),
  text text not null,
  original text,
  author text,          -- correo @benandfrank.com (plugin o Slack)
  channel text          -- figma / slack
);
create index if not exists feedback_brand_idx on feedback (brand);

-- Banco de copys aprobados (👍). Sin duplicados por marca.
create table if not exists copy_bank (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  brand text not null,
  source text,
  text text not null,
  text_hash text generated always as (md5(text)) stored,
  original text,
  author text,
  unique (brand, text_hash)
);

create table if not exists slack_prefs (
  user_id text primary key,
  brand text,
  updated_at timestamptz not null default now()
);

-- Fase 3: bandeja "Mandar a Figma" (se crea ya para no volver a migrar).
create table if not exists figma_inbox (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  email text not null,
  brand text,
  format text,
  text text not null,
  consumed_at timestamptz
);
create index if not exists figma_inbox_email_idx on figma_inbox (email) where consumed_at is null;

alter table usage_log   enable row level security;
alter table feedback    enable row level security;
alter table copy_bank   enable row level security;
alter table slack_prefs enable row level security;
alter table figma_inbox enable row level security;
