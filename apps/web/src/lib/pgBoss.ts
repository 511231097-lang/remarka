import PgBoss from "pg-boss";
import { DOCUMENT_EXTRACT_QUEUE } from "./queue";

let bossPromise: Promise<PgBoss> | null = null;

async function createBoss() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is required for queue operations.");
  }

  const boss = new PgBoss({
    connectionString,
    application_name: "remarka-web",
  });

  await boss.start();
  await boss.createQueue(DOCUMENT_EXTRACT_QUEUE);

  return boss;
}

export async function getBoss() {
  if (!bossPromise) {
    bossPromise = createBoss().catch((error) => {
      bossPromise = null;
      throw error;
    });
  }

  return bossPromise;
}
