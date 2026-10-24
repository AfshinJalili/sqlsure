create type status as enum ('draft', 'live', 'archived');
create table authors (id serial primary key, name text not null, email text unique, created_at timestamptz not null default now());
create table books (
  id bigserial primary key,
  author_id int not null references authors(id),
  title text not null,
  subtitle text,
  status status not null default 'draft',
  price numeric(10,2) not null,
  pages int,
  published_on date,
  cover bytea,
  isbn uuid,
  tags text[] not null default '{}',
  scores int[],
  statuses status[] not null default '{}',
  meta jsonb not null default '{}',
  extra json,
  read_time interval,
  location point,
  rating real,
  weight double precision,
  "Odd Name" text
);
create schema archive;
create table archive.books (id bigint primary key, title text not null);
create view live_books as select id, title from books where status = 'live';
