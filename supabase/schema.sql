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
