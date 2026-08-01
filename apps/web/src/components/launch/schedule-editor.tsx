"use client";

import { BOUNDS, MODEL_BOUNDS } from "@verdant/config";
import { formatDuration } from "@verdant/ui";

import { AmountInput, Field } from "../form";
import type { DraftStage, Issue } from "../../lib/launch";
import { issueFor, ppmToPercent } from "../../lib/launch";

const DAY = 86_400;
const MAX_OFFSET_DAYS = Math.floor(BOUNDS.schedule.startOffset.max / DAY);

/**
 * The fee ladder, as a control.
 *
 * A schedule is a list of (fee, when it starts) and the contract stores exactly that, so
 * this edits exactly that — no wizard, no presets that hide the shape. The first stage's
 * offset is not editable because the contract requires it to be zero: a schedule whose
 * first stage begins after the pool opens would leave the pool with no fee at all for that
 * interval, so the rule is enforced rather than validated.
 *
 * Each row shows the gap from the previous stage in words. "604800" and "7 days" are the
 * same number, and only one of them tells a creator whether they have built what they
 * meant to.
 */
export function ScheduleEditor({
  stages,
  onChange,
  issues,
}: {
  readonly stages: readonly DraftStage[];
  readonly onChange: (stages: readonly DraftStage[]) => void;
  readonly issues: readonly Issue[];
}) {
  const max = MODEL_BOUNDS.progressive.maxStages;
  const min = MODEL_BOUNDS.progressive.minStages;

  function update(index: number, patch: Partial<DraftStage>) {
    onChange(stages.map((stage, at) => (at === index ? { ...stage, ...patch } : stage)));
  }

  function add() {
    const last = stages[stages.length - 1];
    const lastDays = Number(last?.offsetDays ?? "0");
    onChange([
      ...stages,
      {
        feePercent: last?.feePercent ?? "1.00",
        offsetDays: String(Number.isFinite(lastDays) ? lastDays + 7 : 7),
      },
    ]);
  }

  function remove(index: number) {
    onChange(stages.filter((_, at) => at !== index));
  }

  return (
    <div>
      <div className="space-y-3">
        {stages.map((stage, index) => {
          const previous = index === 0 ? null : Number(stages[index - 1]!.offsetDays);
          const current = Number(stage.offsetDays);
          const gap =
            previous === null || !Number.isFinite(previous) || !Number.isFinite(current)
              ? null
              : Math.round((current - previous) * DAY);

          return (
            <div
              key={index}
              className="rounded-xl border border-border bg-surface-sunken p-4 sm:flex sm:items-start sm:gap-4"
            >
              <div className="mb-3 flex items-center gap-2 sm:mb-0 sm:w-28 sm:pt-8">
                {/* `shadow-sm` was a soft grey cast and is invisible here, so the plate is
                    raised by tone and by the inner light edge in `shadow-card` instead. */}
                <span className="numeric grid size-6 place-items-center rounded-md bg-surface-raised text-[0.7rem] font-semibold text-ink shadow-card">
                  {index + 1}
                </span>
                <span className="text-[0.75rem] text-ink-muted">
                  {index === 0 ? "at launch" : gap === null ? "" : `+${formatDuration(gap)}`}
                </span>
              </div>

              <div className="grid flex-1 gap-3 sm:grid-cols-2">
                <Field
                  label="Fee"
                  error={issueFor(issues, `stages.${index}.fee`)}
                  hint={index === 0 ? "Charged from the moment the pool opens" : undefined}
                >
                  <AmountInput
                    value={stage.feePercent}
                    onChange={(value) => update(index, { feePercent: value })}
                    unit="%"
                    placeholder="1.00"
                    invalid={issueFor(issues, `stages.${index}.fee`) !== undefined}
                  />
                </Field>

                <Field
                  label="Starts"
                  error={issueFor(issues, `stages.${index}.offset`)}
                  hint={index === 0 ? "Fixed at launch" : "Days after launch"}
                >
                  {index === 0 ? (
                    <div className="numeric rounded-xl border border-border bg-surface-sunken px-3.5 py-2.5 text-[0.95rem] text-ink-muted">
                      0 days
                    </div>
                  ) : (
                    <AmountInput
                      value={stage.offsetDays}
                      onChange={(value) => update(index, { offsetDays: value })}
                      unit="days"
                      placeholder="7"
                      invalid={issueFor(issues, `stages.${index}.offset`) !== undefined}
                      action={
                        stages.length > min ? (
                          <button
                            type="button"
                            onClick={() => remove(index)}
                            aria-label={`Remove stage ${index + 1}`}
                            className="rounded-md px-1.5 py-1 text-ink-muted transition hover:bg-surface-raised hover:text-fall"
                          >
                            <svg
                              viewBox="0 0 16 16"
                              aria-hidden="true"
                              className="size-3.5"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.6"
                              strokeLinecap="round"
                            >
                              <path d="M4 4l8 8M12 4l-8 8" />
                            </svg>
                          </button>
                        ) : undefined
                      }
                    />
                  )}
                </Field>
              </div>
            </div>
          );
        })}
      </div>

      {issueFor(issues, "stages") === undefined ? null : (
        <p className="mt-2 text-[0.75rem] text-fall">{issueFor(issues, "stages")}</p>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={add}
          disabled={stages.length >= max}
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-surface px-4 text-[0.82rem] font-medium text-ink transition hover:border-border-strong hover:bg-surface-raised disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:border-border"
        >
          <span aria-hidden="true">+</span> Add a stage
        </button>
        <p className="text-[0.72rem] text-ink-muted">
          {stages.length} of {max} stages · fees from{" "}
          {ppmToPercent(BOUNDS.schedule.feePpm.min)}% to {ppmToPercent(BOUNDS.schedule.feePpm.max)}% ·
          up to {MAX_OFFSET_DAYS} days out
        </p>
      </div>
    </div>
  );
}
