import type { Prisma } from "@prisma/client";
import { prisma } from "./client";

type DbExecutor = Prisma.TransactionClient | typeof prisma;

export async function enqueueOutboxEvent(params: {
  client?: DbExecutor;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payloadJson: Prisma.InputJsonValue;
  availableAt?: Date;
}) {
  const client = params.client || prisma;
  const aggregateType = String(params.aggregateType || "").trim();
  const aggregateId = String(params.aggregateId || "").trim();
  const eventType = String(params.eventType || "").trim();

  if (!aggregateType) throw new Error("aggregateType is required");
  if (!aggregateId) throw new Error("aggregateId is required");
  if (!eventType) throw new Error("eventType is required");

  return client.outbox.create({
    data: {
      aggregateType,
      aggregateId,
      eventType,
      payloadJson: params.payloadJson,
      availableAt: params.availableAt || new Date(),
    },
  });
}
