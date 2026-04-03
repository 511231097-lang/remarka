import { BookImportError } from "@remarka/contracts";
import { createProjectImportFromUpload, ImportValidationError } from "@/lib/projectImportState";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const title = String(formData.get("title") || "").trim() || null;
    const description = String(formData.get("description") || "").trim() || null;

    if (!(file instanceof File)) {
      return Response.json(
        {
          error: "VALIDATION_ERROR",
          message: "file is required",
        },
        { status: 400 }
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const created = await createProjectImportFromUpload({
      fileName: file.name,
      mimeType: file.type,
      bytes,
      requestedTitle: title,
      requestedDescription: description,
    });

    return Response.json(
      {
        project: {
          id: created.project.id,
          title: created.project.title,
          description: created.project.description,
          chapters: created.project.chapters.map((chapter) => ({
            id: chapter.id,
            projectId: chapter.projectId,
            title: chapter.title,
            orderIndex: chapter.orderIndex,
            createdAt: chapter.createdAt.toISOString(),
            updatedAt: chapter.updatedAt.toISOString(),
          })),
          latestImport: created.projectImport,
          firstChapterId: created.project.chapters[0]?.id ?? null,
          createdAt: created.project.createdAt.toISOString(),
          updatedAt: created.project.updatedAt.toISOString(),
        },
        import: created.projectImport,
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof ImportValidationError || error instanceof BookImportError) {
      return Response.json(
        {
          error: error.code,
          message: error.message,
        },
        { status: 400 }
      );
    }

    return Response.json(
      {
        error: "INTERNAL_ERROR",
      },
      { status: 500 }
    );
  }
}
