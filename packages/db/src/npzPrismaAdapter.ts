import { prisma } from "./client";

type AnyDbClient = Record<string, any>;

function mapDelegates(client: AnyDbClient) {
  return {
    book: client.book,
    bookChapter: client.bookChapter,
    bookContentVersion: client.bookContentVersion,
    bookAnalysisRun: client.bookAnalysisRun,
    bookStageExecution: client.bookStageExecution,
    bookAnalysisChapterMetric: client.bookAnalysisChapterMetric,
    bookAnalysisArtifact: client.bookAnalysisArtifact,
    bookParagraph: client.bookParagraph,
    bookParagraphEmbedding: client.bookParagraphEmbedding,
    bookEvidenceFragment: client.bookEvidenceFragment,
    bookEvidenceFragmentEmbedding: client.bookEvidenceFragmentEmbedding,
    bookSceneEmbedding: client.bookSceneEmbedding,
    bookScene: client.bookAnalysisScene,
    bookChatThread: client.bookChatThread,
    bookChatMessage: client.bookChatThreadMessage,
    bookChatTurnMetric: client.bookChatTurnMetric,
    bookChatToolRun: client.bookChatToolRun,
    outbox: client.outbox,
  };
}

export function createNpzPrismaAdapter(client: AnyDbClient = prisma as unknown as AnyDbClient) {
  const delegates = mapDelegates(client);

  const adapted: AnyDbClient = {
    ...delegates,
    $connect: typeof client.$connect === "function" ? client.$connect.bind(client) : undefined,
    $disconnect: typeof client.$disconnect === "function" ? client.$disconnect.bind(client) : undefined,
    $queryRaw: typeof client.$queryRaw === "function" ? client.$queryRaw.bind(client) : undefined,
    $queryRawUnsafe: typeof client.$queryRawUnsafe === "function" ? client.$queryRawUnsafe.bind(client) : undefined,
    $executeRaw: typeof client.$executeRaw === "function" ? client.$executeRaw.bind(client) : undefined,
    $executeRawUnsafe: typeof client.$executeRawUnsafe === "function" ? client.$executeRawUnsafe.bind(client) : undefined,
    $transaction: (...args: any[]) => {
      if (typeof client.$transaction !== "function") {
        throw new Error("Prisma client does not support $transaction");
      }

      if (typeof args[0] === "function") {
        const callback = args[0];
        const rest = args.slice(1);
        return client.$transaction((tx: AnyDbClient) => callback(createNpzPrismaAdapter(tx)), ...rest);
      }

      return client.$transaction(...args);
    },
  };

  return adapted;
}
