import postgres from "postgres";

// Fails fast with a readable hint instead of a timeout in every test file.
export default async () => {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://brygadzista:brygadzista@localhost:5433/brygadzista_test";
  const sql = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await sql`select 1`;
  } catch (error) {
    throw new Error(`Brak bazy testowej pod ${url}. Uruchom: pnpm --filter @brygadzista/server test:db\n${String(error)}`);
  } finally {
    await sql.end();
  }
};
