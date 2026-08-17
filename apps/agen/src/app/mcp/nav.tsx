"use client";

import { useEffect, useState } from "react";

/**
 * The index in the margin.
 *
 * ## Why it is a client component at all
 *
 * Only for the highlight. The links are rendered as ordinary anchors and work with no
 * JavaScript whatsoever — a table of contents that needs a script to be clickable would be
 * an embarrassment on a page whose subject is machine-readable interfaces. What the script
 * adds is the one thing an anchor cannot know: which section the reader is looking at now.
 *
 * An observer rather than a scroll listener, because the question is "which of these boxes
 * crosses a line in the upper third of the window", and that is exactly what
 * `IntersectionObserver` answers without running anything on every frame. The `rootMargin`
 * puts the line at 28% from the top, so a heading becomes current as it settles into
 * reading position rather than as it grazes the bottom of the screen.
 */
export interface DocSection {
  readonly id: string;
  readonly label: string;
}

export function DocNav({ sections }: { readonly sections: readonly DocSection[] }) {
  const [current, setCurrent] = useState(sections[0]?.id ?? "");

  useEffect(() => {
    const seen = new Set<string>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) seen.add(entry.target.id);
          else seen.delete(entry.target.id);
        }

        // The topmost section in the band wins, so passing a short section on the way down
        // does not leave the mark behind on the long one above it.
        const first = sections.find((section) => seen.has(section.id));
        if (first !== undefined) setCurrent(first.id);
      },
      { rootMargin: "-28% 0px -62% 0px" },
    );

    for (const section of sections) {
      const element = document.getElementById(section.id);
      if (element !== null) observer.observe(element);
    }

    return () => {
      observer.disconnect();
    };
  }, [sections]);

  return (
    <aside className="cx-side">
      <p className="cx-side-label">Contents</p>

      <nav aria-label="on this page">
        {sections.map((section, index) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            aria-current={section.id === current ? "true" : undefined}
          >
            <i>{String(index + 1).padStart(3, "0")}</i>
            {section.label}
          </a>
        ))}
      </nav>

      <div className="cx-side-foot">
        <a href="/docs/agents">Agent API</a>
        <a href="https://modelcontextprotocol.io" target="_blank" rel="noreferrer">
          What is MCP?
        </a>
      </div>
    </aside>
  );
}
