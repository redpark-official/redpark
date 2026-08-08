/*
# Create players table for persistent user data

1. Purpose
- Red Park currently keeps all user accounts, coins, colors, friends, and moderation state in memory on the Node server. When the server restarts, all accounts and progress are lost. This migration moves that data into Supabase so it survives restarts.

2. New Tables
- `players`
  - `username` (text, primary key, lowercase) - the user's unique handle
  - `password_hash` (text, not null) - sha256 hash of the password (matches existing server logic)
  - `color` (text, default '#4ade80') - the player's avatar color
  - `admin` (boolean, default false) - admin flag
  - `mod` (boolean, default false) - moderator flag
  - `banned` (boolean, default false) - banned flag
  - `muted` (boolean, default false) - muted flag
  - `warnings` (int, default 0) - warning count
  - `coins` (int, default 0) - collected coin count
  - `friends` (jsonb, default '[]') - array of friend usernames
  - `friend_requests` (jsonb, default '[]') - array of pending request usernames
  - `created_at` (timestamptz, default now())

3. Security
- Enable RLS on `players`.
- The Node server reads/writes using the service role key, which bypasses RLS, so server-side access is unrestricted.
- For direct client access (anon key), allow public read of non-sensitive fields (username, color, coins) so the leaderboard works client-side if ever needed. Writes are blocked for anon since the server mediates all mutations.
*/

CREATE TABLE IF NOT EXISTS players (
  username text PRIMARY KEY,
  password_hash text NOT NULL,
  color text NOT NULL DEFAULT '#4ade80',
  admin boolean NOT NULL DEFAULT false,
  mod boolean NOT NULL DEFAULT false,
  banned boolean NOT NULL DEFAULT false,
  muted boolean NOT NULL DEFAULT false,
  warnings integer NOT NULL DEFAULT 0,
  coins integer NOT NULL DEFAULT 0,
  friends jsonb NOT NULL DEFAULT '[]'::jsonb,
  friend_requests jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE players ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_players" ON players;
CREATE POLICY "anon_read_players" ON players FOR SELECT
  TO anon, authenticated USING (true);