#!/usr/bin/env node
/**
 * pnpm verify:docs
 *
 * Resolves every relative link in the repository's markdown.
 *
 * This repository's documentation works by pointing at the thing that backs each
 * claim — a test, a decision record, a deployment field. That only means anything
 * while the links resolve, and a link to a renamed test is worse than no link,
 * because it reads like evidence and is not. So a dead link is a build failure
 * here rather than something a reader discovers.
 *
 * Checks relative links and anchors within the repository. External URLs are left
 * alone: a check that depends on somebody else's uptime fails for reasons that
 * have nothing to do with the commit under test.
 *
 * Dependency-free, like the other verifiers.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const SKIP = new Set([
  "node_modules",
  ".git",
  ".turbo",
  ".vercel",
  ".next",
  ".research",
  ".proof",
  "vendor",
  "out",
  "broadcast",
  "cache",
  "artifacts",
]);

function markdownFiles(directory: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      found.push(...markdownFiles(path));
    } else if (entry.name.endsWith(".md")) {
      found.push(path);
    }
  }

  return found;
}

/** GitHub's heading-to-anchor rule, near enough for our own headings. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function anchorsIn(file: string): Set<string> {
  const anchors = new Set<string>();
  let fenced = false;

  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    if (fenced) continue;

    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (heading) anchors.add(slug(heading[1]));
  }

  return anchors;
}

const anchorCache = new Map<string, Set<string>>();
function anchorsOf(file: string): Set<string> {
  let cached = anchorCache.get(file);
  if (!cached) {
    cached = anchorsIn(file);
    anchorCache.set(file, cached);
  }
  return cached;
}

interface Broken {
  readonly file: string;
  readonly link: string;
  readonly reason: string;
}

const broken: Broken[] = [];

function checkFile(file: string): number {
  const source = readFileSync(file, "utf8");
  const here = dirname(file);
  let checked = 0;

  // Markdown links, plus src= attributes for the inline HTML in the README.
  const links = [
    ...source.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g),
    ...source.matchAll(/(?:src|href)="([^"]+)"/g),
  ];

  for (const match of links) {
    const target = match[1];

    if (/^(https?:|mailto:|#)/.test(target)) {
      // In-page anchors still have to exist.
      if (target.startsWith("#")) {
        checked += 1;
        const anchor = target.slice(1);
        if (anchor && !anchorsOf(file).has(anchor)) {
          broken.push({
            file: relative(ROOT, file),
            link: target,
            reason: "no heading with that anchor in this file",
          });
        }
      }
      continue;
    }

    checked += 1;

    const [path, anchor] = target.split("#");
    const resolved = resolve(here, decodeURIComponent(path));

    if (!existsSync(resolved)) {
      broken.push({
        file: relative(ROOT, file),
        link: target,
        reason: "path does not exist",
      });
      continue;
    }

    if (anchor && resolved.endsWith(".md") && statSync(resolved).isFile()) {
      if (!anchorsOf(resolved).has(anchor)) {
        broken.push({
          file: relative(ROOT, file),
          link: target,
          reason: `${relative(ROOT, resolved)} has no heading with that anchor`,
        });
      }
    }
  }

  return checked;
}

const files = markdownFiles(ROOT).sort();
let total = 0;
for (const file of files) total += checkFile(file);

console.log(`Checked ${total} links across ${files.length} markdown files.`);

if (broken.length > 0) {
  console.log(`\n${broken.length} broken:\n`);
  for (const { file, link, reason } of broken) {
    console.log(`  ${file}`);
    console.log(`    ${link}`);
    console.log(`    ${reason}\n`);
  }
  console.log(
    "A link to a renamed file reads like evidence and is not, which is why this\n" +
      "fails the build rather than waiting to be noticed.",
  );
  process.exit(1);
}

console.log("Every relative link and anchor resolves.");
