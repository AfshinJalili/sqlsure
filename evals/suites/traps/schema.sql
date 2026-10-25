-- Every table here has NOT NULL columns that a careless analyzer would report as never-null in
-- places where Postgres does return NULL.
create domain positive_int as int check (value > 0);
create type mood as enum ('happy', 'sad');
create type pair as (a int, b text);

create table a (id int primary key, label text not null, n int not null);
create table b (id int primary key, a_id int references a(id), label text not null);
create table c (id int primary key, b_id int references b(id), label text not null);
create table weird (
  id int primary key,
  qty positive_int not null,
  moods mood[] not null default '{}',
  p pair,
  j jsonb not null,
  span int4range,
  total int generated always as (id * 2) stored
);
create view a_view as select id, label from a;
create schema other;
create table other.a (id int primary key, note text not null);

-- A DO INSTEAD rule: RETURNING comes from the rule's action, not from the table's constraints.
create table redirected (id int primary key, label text not null);
create table redirect_log (id int, label text);
create rule redirect as on insert to redirected do instead
  insert into redirect_log values (new.id, null) returning redirect_log.id, redirect_log.label;
