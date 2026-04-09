import { prisma } from "../db";

export class DatabaseService {
  async createProjectSchema(projectId: string, schemaSql: string): Promise<void> {
    const schemaName = this.getSchemaName(projectId);

    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

    if (schemaSql && schemaSql.trim()) {
      await prisma.$executeRawUnsafe(`SET search_path TO "${schemaName}", public`);

      const statements = schemaSql
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const stmt of statements) {
        try {
          await prisma.$executeRawUnsafe(stmt);
        } catch (err: any) {
          // If CREATE TABLE IF NOT EXISTS skipped (table exists), try to add missing columns
          if (err?.meta?.code === "42701" || err?.meta?.message?.includes("already exists")) {
            continue;
          }
          console.error(`[DB] Error executing schema statement: ${stmt}`, err);
        }
      }

      // After running CREATE TABLE statements, sync columns from the schema DDL
      await this.syncColumns(schemaName, schemaSql);

      await prisma.$executeRawUnsafe(`SET search_path TO public`);
    }

    console.log(`[DB] Schema "${schemaName}" created/updated`);
  }

  private async syncColumns(schemaName: string, schemaSql: string): Promise<void> {
    // Parse CREATE TABLE statements to extract expected columns
    const tablePattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*?)\)/gi;
    let match;

    while ((match = tablePattern.exec(schemaSql)) !== null) {
      const tableName = match[1].toLowerCase();
      const columnsBlock = match[2];

      // Parse column definitions (skip constraints like PRIMARY KEY, UNIQUE, etc.)
      const lines = columnsBlock.split(",").map(l => l.trim());
      for (const line of lines) {
        // Skip constraint lines
        if (/^\s*(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT|INDEX)/i.test(line)) continue;

        // Extract column name and type from "column_name TYPE [DEFAULT ...] [NOT NULL] ..."
        const colMatch = line.match(/^(\w+)\s+(\w[\w\s()]*?)(?:\s+(?:DEFAULT|NOT\s+NULL|NULL|PRIMARY|UNIQUE|REFERENCES|CHECK).*)?$/i);
        if (!colMatch) continue;

        const colName = colMatch[1].toLowerCase();
        const colType = colMatch[2].trim();

        // Skip pseudo-columns or constraint keywords
        if (["primary", "unique", "foreign", "check", "constraint", "index"].includes(colName)) continue;

        // Extract DEFAULT value if present
        const defaultMatch = line.match(/DEFAULT\s+(.+?)(?:\s+(?:NOT\s+NULL|NULL|PRIMARY|UNIQUE).*)?$/i);
        const defaultVal = defaultMatch ? defaultMatch[1].replace(/,\s*$/, "").trim() : null;

        try {
          let alterSql = `ALTER TABLE "${schemaName}".${tableName} ADD COLUMN IF NOT EXISTS ${colName} ${colType}`;
          if (defaultVal) {
            alterSql += ` DEFAULT ${defaultVal}`;
          }
          await prisma.$executeRawUnsafe(alterSql);
        } catch (err: any) {
          // Column might already exist with a different type — that's ok
          if (!err?.meta?.message?.includes("already exists")) {
            console.error(`[DB] Error adding column ${colName} to ${tableName}:`, err?.meta?.message || err);
          }
        }
      }
    }
  }

  async executeQuery(projectId: string, query: string, params?: any[]): Promise<{ rows: any[]; rowCount: number }> {
    const schemaName = this.getSchemaName(projectId);

    try {
      await prisma.$executeRawUnsafe(`SET search_path TO "${schemaName}", public`);
      const rows = await prisma.$queryRawUnsafe(query, ...(params || [])) as any[];
      await prisma.$executeRawUnsafe(`SET search_path TO public`);
      return { rows, rowCount: rows.length };
    } catch (err) {
      await prisma.$executeRawUnsafe(`SET search_path TO public`).catch(() => {});
      console.error(`[DB] Query error in ${schemaName}:`, err);
      throw err;
    }
  }

  getSchemaName(projectId: string): string {
    return `project_${projectId.replace(/-/g, "_")}`;
  }

  async dropProjectSchema(projectId: string): Promise<void> {
    const schemaName = this.getSchemaName(projectId);
    try {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      console.log(`[DB] Dropped schema ${schemaName}`);
    } catch (err) {
      console.error(`[DB] Failed to drop schema ${schemaName}:`, err);
    }
  }
}

export const databaseService = new DatabaseService();
