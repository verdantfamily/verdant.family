import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DOC_GROUPS, DOC_SECTIONS, docNeighbours, docSection } from "../../../content/docs";

interface PageProps {
  readonly params: Promise<{ readonly slug?: readonly string[] }>;
}

/**
 * Every documentation page is this file.
 *
 * The content lives in one module and the routes are generated from it, so a section cannot
 * exist without being linked and a link cannot resolve to nothing. `generateStaticParams`
 * makes each one a static page: documentation does not depend on the indexer, so it should
 * not fail when the indexer does.
 */
export function generateStaticParams(): { readonly slug: readonly string[] }[] {
  return DOC_SECTIONS.map((section) => ({
    slug: section.slug === "" ? [] : [section.slug],
  }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const section = docSection(slug?.[0]);
  if (section === undefined) return { title: "Docs" };
  return { title: section.title, description: section.summary };
}

export default async function DocsPage({ params }: PageProps) {
  const { slug } = await params;

  // A deeper path than one segment is not a section, so it is a 404 rather than a
  // silent fallback to the overview — a wrong URL that renders content looks correct.
  if (slug !== undefined && slug.length > 1) notFound();

  const section = docSection(slug?.[0]);
  if (section === undefined) notFound();

  const { previous, next } = docNeighbours(section.slug);
  const groups = Object.keys(DOC_GROUPS) as (keyof typeof DOC_GROUPS)[];

  return (
    <div className="mx-auto max-w-6xl px-6 pb-20 pt-12">
      <div className="mb-10">
        <p className="text-[0.8rem] font-medium text-accent">Documentation</p>
        <h1 className="display mt-2 text-[2.25rem] text-ink">
          Launch models, explained plainly
        </h1>
        <p className="mt-3 max-w-2xl text-[1rem] leading-relaxed text-ink-muted">
          What the pool does, what the fee does, where the money goes and what none of it
          guarantees — before you sign anything.
        </p>
      </div>

      <div className="grid gap-10 lg:grid-cols-[15rem_1fr] lg:items-start">
        <nav className="lg:sticky lg:top-24">
          {groups.map((group) => (
            <div key={group} className="mb-6">
              <p className="px-3 text-[0.68rem] font-semibold uppercase tracking-wider text-ink-muted">
                {DOC_GROUPS[group]}
              </p>
              <ul className="mt-2 space-y-0.5">
                {DOC_SECTIONS.filter((entry) => entry.group === group).map((entry) => {
                  const current = entry.slug === section.slug;
                  return (
                    <li key={entry.slug}>
                      <Link
                        href={entry.slug === "" ? "/docs" : `/docs/${entry.slug}`}
                        aria-current={current ? "page" : undefined}
                        className={`block rounded-lg px-3 py-1.5 text-[0.85rem] transition ${
                          current
                            ? "bg-accent-soft font-medium text-accent-strong"
                            : "text-ink-muted hover:bg-surface hover:text-ink"
                        }`}
                      >
                        {entry.title}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <article className="min-w-0">
          <div className="rounded-panel border border-border bg-surface p-7 shadow-card backdrop-blur-xl sm:p-10">
            <h2 className="display text-[1.75rem] text-ink">{section.title}</h2>
            <p className="mt-2 text-[0.92rem] text-ink-muted">{section.summary}</p>
            <div className="mt-8">{section.body}</div>
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            {previous === undefined ? null : (
              <Link
                href={previous.slug === "" ? "/docs" : `/docs/${previous.slug}`}
                className="flex-1 rounded-card border border-border bg-surface px-5 py-4 shadow-card backdrop-blur-xl transition hover:border-border-strong hover:shadow-lift"
              >
                <span className="text-[0.7rem] uppercase tracking-wider text-ink-muted">
                  Previous
                </span>
                <span className="mt-0.5 block text-[0.9rem] font-medium text-ink">
                  {previous.title}
                </span>
              </Link>
            )}
            {next === undefined ? null : (
              <Link
                href={`/docs/${next.slug}`}
                className="flex-1 rounded-card border border-border bg-surface px-5 py-4 text-right shadow-card backdrop-blur-xl transition hover:border-border-strong hover:shadow-lift"
              >
                <span className="text-[0.7rem] uppercase tracking-wider text-ink-muted">Next</span>
                <span className="mt-0.5 block text-[0.9rem] font-medium text-ink">
                  {next.title}
                </span>
              </Link>
            )}
          </div>
        </article>
      </div>
    </div>
  );
}
