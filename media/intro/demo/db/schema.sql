create table users (
  id serial primary key,
  email text not null unique,
  display_name text,
  created_at timestamptz not null default now()
);
