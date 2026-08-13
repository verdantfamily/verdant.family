/**
 * Answering the question a build stopped on.
 *
 * The pipeline has been able to pause at `awaiting_clarification` since it was written,
 * and `answerBuild` has been able to resume from it for just as long — but nothing
 * exposed that, so a build which asked a question was a build that could never finish.
 * It sat at two ticks and five grey stages until somebody gave up on it.
 *
 * Returns 202 like the route that starts a build, and for the same reason: an answer
 * restarts architecture, generation, compilation and testing, which is minutes of work.
 */

import { NextResponse } from "next/server";

import { answerBuildQuestions } from "../../../../lib/builds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  answers?: unknown;
}

/**
 * An answer is a question id and, optionally, what the creator said.
 *
 * Optional because taking Agen's default is a real answer and the most common one. It is
 * how a creator says "I don't mind" without having to type a sentence that means that —
 * `decide` folds the default into the specification as a visible assumption either way.
 */
function parse(raw: unknown): readonly { readonly id: string; readonly answer?: string }[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const answers: { id: string; answer?: string }[] = [];

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;

    const { id, answer } = entry as { id?: unknown; answer?: unknown };
    if (typeof id !== "string" || id.trim().length === 0) return null;

    if (answer === undefined || (typeof answer === "string" && answer.trim().length === 0)) {
      answers.push({ id });
      continue;
    }

    if (typeof answer !== "string") return null;
    if (answer.length > 2_000) return null;

    answers.push({ id, answer: answer.trim() });
  }

  return answers;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "The request body was not JSON." }, { status: 400 });
  }

  const answers = parse(body.answers);
  if (answers === null) {
    return NextResponse.json(
      { error: "Send an answers array of { id, answer? } entries." },
      { status: 400 },
    );
  }

  const result = await answerBuildQuestions(id, answers);

  if (!result.ok) {
    // 404 for a build that is not there, 503 for a server that cannot continue one:
    // the first is the caller's mistake and the second is an operator's.
    const missing = result.error?.includes("no build") === true;
    return NextResponse.json({ error: result.error }, { status: missing ? 404 : 503 });
  }

  return NextResponse.json({ jobId: result.jobId }, { status: 202 });
}
