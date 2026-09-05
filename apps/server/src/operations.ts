import BetterSqlite3 from "better-sqlite3";

export async function createConsistentSnapshot(source: string, destination: string): Promise<void> {
  const database = new BetterSqlite3(source, { readonly: true, fileMustExist: true });
  try {
    await database.backup(destination);
  } finally {
    database.close();
  }
  if (integrityCheck(destination) !== "ok") throw new Error("Snapshot integrity check failed");
}

export function integrityCheck(filename: string): string {
  const database = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
  try {
    return database.pragma("integrity_check", { simple: true }) as string;
  } finally {
    database.close();
  }
}
