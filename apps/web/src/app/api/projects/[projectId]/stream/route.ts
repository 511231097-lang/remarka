import { prisma } from "@remarka/db";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ projectId: string }>;
}

function formatSseEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function serializeRun(run: any | null) {
  if (!run) return null;

  return {
    id: run.id,
    projectId: run.projectId,
    documentId: run.documentId,
    chapterId: run.chapterId,
    contentVersion: run.contentVersion,
    state: run.state,
    phase: run.phase,
    error: run.error || null,
    createdAt: run.createdAt?.toISOString?.() || null,
    startedAt: run.startedAt?.toISOString?.() || null,
    completedAt: run.completedAt?.toISOString?.() || null,
    updatedAt: run.updatedAt?.toISOString?.() || null,
  };
}

export async function GET(request: Request, context: RouteContext) {
  const { projectId } = await Promise.resolve(context.params);
  const url = new URL(request.url);
  const requestedChapterId = url.searchParams.get("chapter")?.trim() || null;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });

  if (!project) {
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  const encoder = new TextEncoder();
  let statusInterval: ReturnType<typeof setInterval> | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let lastRunId: string | null = null;
      let lastPhase: string | null = null;
      let lastState: string | null = null;
      let lastContentVersion: number | null = null;

      const close = () => {
        if (closed) return;
        closed = true;
        if (statusInterval) clearInterval(statusInterval);
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        controller.close();
      };

      const send = (event: string, payload: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(formatSseEvent(event, payload)));
      };

      const poll = async () => {
        try {
          const chapter = requestedChapterId
            ? await prisma.chapter.findFirst({
                where: {
                  id: requestedChapterId,
                  projectId,
                },
                select: { id: true },
              })
            : null;

          if (requestedChapterId && !chapter) {
            send("error", { message: "Chapter not found" });
            return;
          }

          const effectiveChapterId =
            chapter?.id ||
            (
              await prisma.chapter.findFirst({
                where: { projectId },
                orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
                select: { id: true },
              })
            )?.id ||
            null;

          if (!effectiveChapterId) {
            return;
          }

          const document = await prisma.document.findUnique({
            where: { chapterId: effectiveChapterId },
            select: {
              id: true,
              currentRunId: true,
              contentVersion: true,
              updatedAt: true,
            },
          });

          if (!document) {
            return;
          }

          const run = document.currentRunId
            ? await prisma.analysisRun.findUnique({
                where: { id: document.currentRunId },
              })
            : await prisma.analysisRun.findFirst({
                where: { documentId: document.id },
                orderBy: [{ createdAt: "desc" }],
              });

          const runPayload = serializeRun(run);

          if (runPayload?.id && runPayload.id !== lastRunId) {
            send("run_started", {
              chapterId: effectiveChapterId,
              run: runPayload,
            });
            lastRunId = runPayload.id;
          }

          if (runPayload?.phase && runPayload.phase !== lastPhase) {
            send("phase_changed", {
              chapterId: effectiveChapterId,
              run: runPayload,
            });
            lastPhase = runPayload.phase;
          }

          if (document.contentVersion !== lastContentVersion) {
            send("snapshot_updated", {
              chapterId: effectiveChapterId,
              runId: runPayload?.id || null,
              contentVersion: document.contentVersion,
              updatedAt: document.updatedAt.toISOString(),
            });
            lastContentVersion = document.contentVersion;
          }

          const nextState = runPayload?.state || null;
          if (nextState && nextState !== lastState) {
            if (nextState === "completed") {
              send("completed", {
                chapterId: effectiveChapterId,
                run: runPayload,
              });
            } else if (nextState === "failed") {
              send("failed", {
                chapterId: effectiveChapterId,
                run: runPayload,
              });
            } else if (nextState === "superseded") {
              send("superseded", {
                chapterId: effectiveChapterId,
                run: runPayload,
              });
            }
            lastState = nextState;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Status poll failed";
          send("error", { message });
        }
      };

      send("ready", { projectId, chapterId: requestedChapterId });
      void poll();

      statusInterval = setInterval(() => {
        void poll();
      }, 1200);

      heartbeatInterval = setInterval(() => {
        send("heartbeat", { ts: Date.now() });
      }, 20_000);

      const onAbort = () => {
        request.signal.removeEventListener("abort", onAbort);
        close();
      };

      request.signal.addEventListener("abort", onAbort);
    },
    cancel() {
      if (statusInterval) clearInterval(statusInterval);
      if (heartbeatInterval) clearInterval(heartbeatInterval);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
