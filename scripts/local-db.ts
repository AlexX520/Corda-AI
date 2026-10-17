import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import path from 'node:path';
async function main() {
  const directory = path.resolve('.data/postgres');
  const pg = new EmbeddedPostgres({
    databaseDir: directory,
    user: 'conference',
    password: 'conference',
    port: 54329,
    persistent: true,
    postgresFlags: ['-h', '127.0.0.1'],
    onLog: () => {},
    onError: (e) => console.error(String(e)),
  });
  if (!existsSync(path.join(directory, 'PG_VERSION'))) await pg.initialise();
  await pg.start();
  const client = pg.getPgClient();
  await client.connect();
  const existing = await client.query("SELECT 1 FROM pg_database WHERE datname='conferenceos'");
  await client.end();
  if (!existing.rowCount) await pg.createDatabase('conferenceos');
  console.log(
    'PostgreSQL ready on 127.0.0.1:54329. Data persists in .data/postgres. Keep this terminal open.',
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setInterval(() => {}, 60000);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
