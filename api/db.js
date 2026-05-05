import { createClient } from "@libsql/client";

export function getDbClient() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url || !authToken) {
    throw new Error("Missing Turso database credentials in environment variables");
  }

  return createClient({
    url,
    authToken,
  });
}
