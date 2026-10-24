create type order_status as enum ('pending', 'paid', 'shipped', 'cancelled');

create table users (
  id serial primary key,
  email text not null unique,
  display_name text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  last_login timestamptz,
  settings jsonb not null default '{}',
  tags text[]
);

create table categories (
  id serial primary key,
  name text not null,
  parent_id int references categories(id)
);

create table products (
  id bigserial primary key,
  sku uuid not null default gen_random_uuid(),
  name text not null,
  description text,
  price numeric(12, 2) not null,
  weight_grams int,
  category_id int references categories(id),
  photo bytea,
  ratings int[] not null default '{}'
);

create table orders (
  id bigserial primary key,
  user_id int not null references users(id),
  status order_status not null default 'pending',
  placed_on date not null default current_date,
  shipped_at timestamp,
  note text
);

create table order_items (
  order_id bigint not null references orders(id),
  product_id bigint not null references products(id),
  quantity int not null check (quantity > 0),
  unit_price numeric(12, 2) not null,
  primary key (order_id, product_id)
);

create table reviews (
  id serial primary key,
  product_id bigint not null references products(id),
  user_id int references users(id),
  stars smallint not null check (stars between 1 and 5),
  body text,
  meta json
);

create view product_summary as
  select p.id, p.name, c.name as category, count(r.id) as review_count
  from products p left join categories c on c.id = p.category_id left join reviews r on r.product_id = p.id
  group by p.id, p.name, c.name;
