import { LAUNCH_MODELS, QUOTE_ASSETS } from "@verdant/config";
import type { Metadata } from "next";
import Link from "next/link";

import { LaunchForm } from "../../../components/launch/launch-form";
import { LaunchSoon } from "../../../components/launch-soon";
import { Badge, Notice, PageHeading } from "../../../components/primitives";
import { LAUNCHING_OPEN } from "../../../lib/launch-window";

export const metadata: Metadata = {
  title: "Launch Stock-Paired",
  description:
    "A fixed-supply token priced against a tokenized equity on Robinhood Chain, with the swap fee written into the pool at creation.",
};

export default function StockPairedLaunchPage() {
  const model = LAUNCH_MODELS["stock-paired"];

  if (!LAUNCHING_OPEN) {
    return (
      <div className="px-6 py-24">
        <LaunchSoon />
      </div>
    );
  }

  return (
    <div className="pb-16">
      <section className="px-6 pb-10 pt-16">
        <PageHeading
          eyebrow={
            <div className="flex items-center justify-center gap-2">
              <Link
                href="/launch"
                className="text-[0.8rem] text-ink-muted transition-colors hover:text-ink"
              >
                ← Models
              </Link>
              <Badge>{model.label}</Badge>
            </div>
          }
          title="Launch Stock-Paired"
          lede={`Priced against one of ${QUOTE_ASSETS.length} reviewed equity tokens rather than ether. Everything else behaves exactly as Classic does.`}
        />
      </section>

      <div className="mx-auto mb-6 max-w-6xl px-6">
        <Notice title="You need the quote asset before you launch">
          <p>
            The first buy happens inside the launch, and it is funded in the asset the market
            is quoted in — so hold the equity token first. Nothing here swaps ether into it
            for you, and a launch that names an asset you do not hold will be refused by the
            contract rather than half-performed.
          </p>
        </Notice>
      </div>

      <LaunchForm modelId="stock-paired" />
    </div>
  );
}
