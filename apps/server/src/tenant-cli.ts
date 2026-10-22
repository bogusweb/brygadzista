// Export or delete all data of one firm with a single command (#94, RODO), e.g. in the app container:
//   node dist/tenant-cli.js list
//   node dist/tenant-cli.js export <tenantId> > firma.tar.gz
//   node dist/tenant-cli.js delete <tenantId> "<exact firm name>"
import { pipeline } from "node:stream/promises";
import { sql } from "./db.js";
import { deleteTenant, exportTenant } from "./operator.js";

const [command, tenantId, confirm] = process.argv.slice(2);

const tenant = async () => {
  const [row] = tenantId ? await sql<{ id: string; name: string }[]>`select id, name from tenants where id::text = ${tenantId}` : [];
  if (!row) throw new Error(`Nie ma firmy ${tenantId ?? ""}`);
  return row;
};

try {
  if (command === "list") {
    for (const row of await sql`select id, name, disabled_at is not null as disabled from tenants order by created_at`) {
      console.log(`${row.id}\t${row.name}${row.disabled ? "\t(zablokowana)" : ""}`);
    }
  } else if (command === "export") {
    await pipeline(await exportTenant((await tenant()).id), process.stdout);
  } else if (command === "delete") {
    const found = await tenant();
    if (confirm !== found.name) throw new Error(`Podaj dokładną nazwę firmy jako trzeci argument: "${found.name}"`);
    await sql`
      insert into operator_audit (tenant_id, tenant_name, action, operator_name) values (${found.id}, ${found.name}, 'delete', 'CLI')`;
    await deleteTenant(found.id);
    console.error(`Usunięto firmę ${found.name}`);
  } else {
    console.error("Użycie: tenant-cli list | export <id> | delete <id> <nazwa>");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
} finally {
  await sql.end();
}
