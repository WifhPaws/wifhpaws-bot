create table public.user_points (
  user_id      bigint   primary key,
  username     text,
  points       integer  not null default 0,
  updated_at   timestamp with time zone default now()
);

-- Enable Row Level Security (optional but recommended)
alter table public.user_points enable row level security;

-- Simple policy allowing any authenticated user to select/update their own row
create policy "allow read/write for authenticated users"
  on public.user_points
  for all
  using (auth.role() = 'authenticated');

-- Table for token payout configuration (single row)
create table public.trivia_payouts (
  id            int primary key default 1,
  first_amount  numeric not null default 0,
  second_amount numeric not null default 0,
  third_amount  numeric not null default 0
);

-- Table for per‑place reward amounts (admin can set via /settriviapayout)
create table public.trivia_rewards_config (
  place  int primary key,
  amount numeric not null default 0
);
