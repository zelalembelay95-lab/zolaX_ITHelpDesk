-- Dispatch — IT Helpdesk Queue
-- Run this in the Supabase SQL editor (Project > SQL Editor > New query).
-- This schema is designed to be driven by a trusted backend (Cloudflare Worker)
-- using the Supabase SERVICE ROLE key, because auth is handled by Firebase,
-- not Supabase Auth — so Supabase's built-in auth.uid() based RLS can't be
-- used directly. See README.md for why, and for the recommended architecture.

create extension if not exists "uuid-ossp";

-- People. firebase_uid is the Firebase Auth UID (the source of truth for login).
create table if not exists profiles (
  id            uuid primary key default uuid_generate_v4(),
  firebase_uid  text unique not null,
  name          text not null,
  title         text not null,           -- e.g. 'CEO', 'Manager', 'Store', 'HR', 'Finance', 'IT Support', 'Administrator'
  is_admin      boolean not null default false,
  is_it         boolean not null default false,
  created_at    timestamptz not null default now()
);

-- Issue categories and their priority weights (admin-editable).
create table if not exists categories (
  id            text primary key,        -- short slug, e.g. 'printer'
  label         text not null,
  department    text not null,           -- 'IT' routes into the queue; anything else is a redirect
  weight        int not null default 0 check (weight >= 0 and weight <= 100),
  avg_minutes   int not null default 15 check (avg_minutes >= 0)
);

insert into categories (id, label, department, weight, avg_minutes) values
  ('server',    'Server / core system down',      'IT',      100, 55),
  ('net',       'Network / internet down',        'IT',      95,  40),
  ('pcdown',    'Computer won''t turn on',         'IT',      80,  35),
  ('printer',   'Printer not working',            'IT',      70,  25),
  ('email',     'Email not working',              'IT',      65,  20),
  ('login',     'Can''t log in / password reset', 'IT',      60,  15),
  ('software',  'Software install or error',      'IT',      45,  20),
  ('other-it',  'Other IT issue',                 'IT',      40,  20),
  ('peripheral','Mouse, keyboard or monitor',      'IT',      35,  15),
  ('media',     'Media player (e.g. VLC) issue',  'IT',      15,  10),
  ('payroll',   'Payroll / salary issue',         'Finance', 0,   0),
  ('expense',   'Expense / reimbursement',        'Finance', 0,   0),
  ('leave',     'Leave / attendance request',     'HR',      0,   0),
  ('hiring',    'Hiring / staffing question',     'HR',      0,   0),
  ('inventory', 'Store / inventory issue',        'Store',   0,   0),
  ('other',     'Something else (not IT)',        'Other',   0,   0)
on conflict (id) do nothing;

-- Tickets.
create table if not exists tickets (
  id            uuid primary key default uuid_generate_v4(),
  seq           serial,                              -- human-friendly ticket number
  profile_id    uuid not null references profiles(id),
  category_id   text not null references categories(id),
  severity      text not null default 'normal' check (severity in ('low','normal','high','critical')),
  description   text,
  status        text not null default 'open' check (status in ('open','in_progress','resolved')),
  score         int not null default 0,               -- weight * severity multiplier, computed by the backend on insert
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);

create index if not exists idx_tickets_status_score on tickets (status, score desc, created_at asc);

-- Row Level Security: locked down by default. The Cloudflare Worker talks to
-- Supabase with the SERVICE ROLE key, which bypasses RLS entirely and enforces
-- who-can-do-what itself (based on the verified Firebase identity). This is the
-- standard pattern when auth and database are two different providers.
alter table profiles enable row level security;
alter table categories enable row level security;
alter table tickets enable row level security;
-- No policies are added: with RLS on and no policies, the anon/public key can
-- read and write nothing. Only the service-role key (used server-side only,
-- never shipped to the browser) can access these tables.
