import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";

interface ProfileSettingsDTO {
  defaultBookVisibilityPublic: boolean;
}

function toProfileSettingsDTO(defaultBookVisibilityPublic: boolean): ProfileSettingsDTO {
  return {
    defaultBookVisibilityPublic,
  };
}

export async function GET() {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(toProfileSettingsDTO(authUser.defaultBookVisibilityPublic));
}

export async function PATCH(request: Request) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const defaultBookVisibilityPublic = (payload as { defaultBookVisibilityPublic?: unknown })
    ?.defaultBookVisibilityPublic;

  if (typeof defaultBookVisibilityPublic !== "boolean") {
    return NextResponse.json(
      { error: "defaultBookVisibilityPublic must be a boolean" },
      { status: 400 }
    );
  }

  const updated = await prisma.user.update({
    where: { id: authUser.id },
    data: { defaultBookVisibilityPublic },
    select: {
      defaultBookVisibilityPublic: true,
    },
  });

  return NextResponse.json(toProfileSettingsDTO(updated.defaultBookVisibilityPublic));
}
