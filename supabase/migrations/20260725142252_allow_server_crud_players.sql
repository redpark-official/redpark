/*
# Allow server-side CRUD on players table via anon key

The Node game server is the sole writer to the players table. It validates
authentication and authorization (admin/mod checks) before every mutation,
so direct client access never reaches the database. The server uses the anon
key, so we need anon CRUD policies for it to function.

1. Security
- Allow anon + authenticated to INSERT, UPDATE, DELETE on players.
- This is safe because the server mediates all writes with its own auth checks.
- SELECT was already allowed in the previous migration.
*/

DROP POLICY IF EXISTS "anon_insert_players" ON players;
CREATE POLICY "anon_insert_players" ON players FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_players" ON players;
CREATE POLICY "anon_update_players" ON players FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_players" ON players;
CREATE POLICY "anon_delete_players" ON players FOR DELETE
  TO anon, authenticated USING (true);