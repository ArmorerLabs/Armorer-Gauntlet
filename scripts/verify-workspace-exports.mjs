#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoots = ["packages", "apps"];
const workspaces = new Map();
const failures = [];
const checkedPackages = new Set();

for (const workspaceRoot of workspaceRoots) {
  const absoluteRoot = resolve(root, workspaceRoot);
  if (!existsSync(absoluteRoot)) continue;
  for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = resolve(absoluteRoot, entry.name);
    const manifestPath = resolve(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.name) workspaces.set(manifest.name, { dir, manifest, workspaceRoot });
  }
}

for (const workspace of workspaces.values()) {
  if (workspace.workspaceRoot === "packages") await verifyOnce(workspace);
}

for (const consumer of workspaces.values()) {
  for (const dependencyName of internalDependencyNames(consumer.manifest)) {
    const dependency = workspaces.get(dependencyName);
    if (dependency) await verifyOnce(dependency);
  }
}

if (failures.length > 0) {
  console.error("Workspace export verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Workspace package exports are present and importable.");

async function verifyOnce(pkg) {
  const name = pkg.manifest.name;
  if (checkedPackages.has(name)) return;
  checkedPackages.add(name);
  await verifyPackage(pkg);
}

async function verifyPackage(pkg) {
  const targets = manifestFileTargets(pkg.manifest);
  if (targets.length === 0) return;

  for (const target of targets) {
    const absoluteTarget = resolve(pkg.dir, target);
    if (!existsSync(absoluteTarget)) {
      failures.push(`${pkg.manifest.name} declares ${target}, but that file does not exist. Run npm run build:libs.`);
    }
  }

  const importTarget = runtimeImportTarget(pkg.manifest);
  if (!importTarget || importTarget.includes("*")) return;

  const absoluteImport = resolve(pkg.dir, importTarget);
  if (!existsSync(absoluteImport)) return;

  try {
    await import(pathToFileURL(absoluteImport).href);
  } catch (error) {
    failures.push(`${pkg.manifest.name} exports ${importTarget}, but importing it failed: ${error.message}`);
  }
}

function internalDependencyNames(manifest) {
  const dependencyBlocks = [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.peerDependencies,
    manifest.optionalDependencies
  ];
  return dependencyBlocks.flatMap((block) => Object.keys(block ?? {})).filter((name) => workspaces.has(name));
}

function manifestFileTargets(manifest) {
  const targets = new Set();
  for (const target of [manifest.main, manifest.types]) {
    if (isRelativeFileTarget(target)) targets.add(target);
  }
  for (const target of exportFileTargets(manifest.exports)) {
    if (isRelativeFileTarget(target)) targets.add(target);
  }
  return [...targets].sort();
}

function exportFileTargets(value) {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(exportFileTargets);
  if (typeof value === "object") return Object.values(value).flatMap(exportFileTargets);
  return [];
}

function runtimeImportTarget(manifest) {
  const fromExports = findRuntimeExport(manifest.exports);
  if (isRelativeFileTarget(fromExports)) return fromExports;
  if (isRelativeFileTarget(manifest.main)) return manifest.main;
  return undefined;
}

function findRuntimeExport(value) {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRuntimeExport(item);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;

  for (const condition of ["import", "default", "node", "browser"]) {
    const found = findRuntimeExport(value[condition]);
    if (found) return found;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key === "types") continue;
    const found = findRuntimeExport(nested);
    if (found) return found;
  }
  return undefined;
}

function isRelativeFileTarget(target) {
  return typeof target === "string" && target.startsWith("./") && !target.includes("*");
}
