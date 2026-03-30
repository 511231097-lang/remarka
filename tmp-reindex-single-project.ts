import { prisma } from "/home/west/Documents/myb/remarka/packages/db/src/client.ts";
import { processDocumentExtract } from "/home/west/Documents/myb/remarka/apps/worker/src/jobs/processDocumentExtract.ts";

const projectId = "cmnd5mhiu0015f7e7xi3oda5r";

async function main() {
  const doc = await prisma.document.findUnique({
    where: { projectId },
    select: { id: true, contentVersion: true },
  });

  if (!doc) {
    throw new Error("Document not found");
  }

  await prisma.document.update({
    where: { id: doc.id },
    data: {
      analysisStatus: "queued",
      lastAnalyzedVersion: null,
      lastAnalyzedContent: null,
    },
  });

  const job = await prisma.analysisJob.create({
    data: {
      projectId,
      documentId: doc.id,
      contentVersion: doc.contentVersion,
      status: "queued",
    },
    select: {
      id: true,
      projectId: true,
      documentId: true,
      contentVersion: true,
    },
  });

  console.log("queued", JSON.stringify(job));

  await processDocumentExtract({
    jobId: job.id,
    projectId: job.projectId,
    documentId: job.documentId,
    contentVersion: job.contentVersion,
  });

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      document: {
        select: {
          analysisStatus: true,
          lastAnalyzedVersion: true,
          _count: { select: { mentions: true, annotations: true } },
        },
      },
      _count: { select: { entities: true, analysisJobs: true } },
    },
  });

  const spencers = await prisma.entity.findMany({
    where: { projectId, name: { contains: "Спенсер", mode: "insensitive" } },
    select: {
      id: true,
      type: true,
      name: true,
      _count: { select: { mentions: true } },
      mentions: {
        select: {
          paragraphIndex: true,
          sourceText: true,
        },
        orderBy: [{ paragraphIndex: "asc" }, { startOffset: "asc" }],
      },
    },
    orderBy: [{ type: "asc" }, { name: "asc" }],
  });

  const p16 = await prisma.mention.findMany({
    where: { documentId: doc.id, paragraphIndex: 16 },
    select: {
      sourceText: true,
      entity: { select: { type: true, name: true } },
    },
    orderBy: { startOffset: "asc" },
  });

  console.log("project", JSON.stringify(project, null, 2));
  console.log("spencers", JSON.stringify(spencers, null, 2));
  console.log("p16", JSON.stringify(p16, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
