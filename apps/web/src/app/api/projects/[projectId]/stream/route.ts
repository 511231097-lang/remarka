import { prisma } from "@remarka/db";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ projectId: string }>;
}

function formatSseEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
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
      let lastFingerprint = "";

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

          const document = effectiveChapterId
            ? await prisma.document.findUnique({
                where: {
                  chapterId: effectiveChapterId,
                },
                select: {
                  analysisStatus: true,
                  contentVersion: true,
                  lastAnalyzedVersion: true,
                  updatedAt: true,
                },
              })
            : null;

          const payload = {
            chapterId: effectiveChapterId,
            analysisStatus: document?.analysisStatus ?? "idle",
            contentVersion: document?.contentVersion ?? 0,
            lastAnalyzedVersion: document?.lastAnalyzedVersion ?? null,
            updatedAt: document?.updatedAt?.toISOString() ?? null,
          };

          const fingerprint = `${payload.chapterId || "-"}:${payload.analysisStatus}:${payload.contentVersion}:${
            payload.lastAnalyzedVersion ?? -1
          }:${payload.updatedAt || "-"}`;

          if (fingerprint !== lastFingerprint) {
            lastFingerprint = fingerprint;
            send("status", payload);
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
      }, 1500);

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
