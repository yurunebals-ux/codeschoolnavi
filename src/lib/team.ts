// Loads the AI project team and exposes each role's persona for use as an
// LLM system prompt. Each pipeline stage acts "as" its owning role.
import { readFileSync } from "node:fs";
import { paths } from "./config.js";
import { resolve } from "node:path";

export interface Role {
  id: string;
  title: string;
  owns: string;
  mission: string;
  persona: string;
}
export interface Team {
  project: string;
  owner: any;
  director: any;
  roles: Role[];
}

let cached: Team | null = null;
export function team(): Team {
  if (cached) return cached;
  cached = JSON.parse(readFileSync(resolve(paths.data, "team.json"), "utf8"));
  return cached!;
}

export function persona(roleId: string): string {
  const r = team().roles.find((x) => x.id === roleId);
  return r ? r.persona : "You are a helpful expert.";
}
