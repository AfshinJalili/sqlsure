create table users (
  id serial primary key,
  email text not null unique,
  display_name text,
  created_at timestamptz not null default now()
);

create table posts (
  id serial primary key,
  author_id int not null references users(id),
  title text not null,
  published boolean not null default false
);
