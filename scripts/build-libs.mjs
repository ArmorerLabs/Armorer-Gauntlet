#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");

const libraries = existsSync(packagesDir)
  ? readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(packagesDir, entry.name, "package.json"))
      .filter((path) => existsSync(path))
      .map((path) => ({ dir: dirname(path), manifest: JSON.parse(readFileSync(path, "utf8")) }))
      .filter((workspace) => workspace.manifest.name && workspace.manifest.scripts?.build)
      .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
  : [];
const librariesByName = new Map(libraries.map((library) => [library.manifest.name, library]));
const libraryWorkspaces = dependencyOrderedNames(libraries);

if (libraryWorkspaces.length === 0) {
  console.log("No library workspaces found under packages/.");
  process.exit(0);
}

console.log(`Building workspace libraries: ${libraryWorkspaces.join(", ")}`);
const result = spawnSync("npm", ["run", "build", ...libraryWorkspaces.flatMap((name) => ["-w", name])], {
  cwd: root,
  stdio: "inherit"
});

process.exit(result.status ?? 1);

function dependencyOrderedNames(workspaces) {
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();

  for (const workspace of workspaces) visit(workspace);
  return ordered;

  function visit(workspace) {
    const name = workspace.manifest.name;
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      console.error(`Cyclic package dependency detected while building ${name}.`);
      process.exit(1);
    }

    visiting.add(name);
    for (const dependencyName of internalDependencyNames(workspace.manifest)) {
      const dependency = librariesByName.get(dependencyName);
      if (dependency) visit(dependency);
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(name);
  }
}

function internalDependencyNames(manifest) {
  return [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.peerDependencies,
    manifest.optionalDependencies
  ].flatMap((block) => Object.keys(block ?? {}));
}
