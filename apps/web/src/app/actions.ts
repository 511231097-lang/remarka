"use server";

import { createProject } from "@/lib/projectState";
import { redirect } from "next/navigation";

export async function createProjectAction(formData: FormData) {
  const title = String(formData.get("title") || "").trim();
  const description = String(formData.get("description") || "").trim();

  if (!title) {
    redirect("/");
  }

  const project = await createProject({
    title,
    description: description || null,
  });

  redirect(`/projects/${project.id}`);
}
