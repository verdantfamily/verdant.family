import { LAUNCH_MODELS, QUOTE_ASSETS } from "@verdant/config";
import type { Metadata } from "next";
import Link from "next/link";

import { LaunchForm } from "../../../components/launch/launch-form";
import { Badge, Notice, PageHeading } from "../../../components/primitives";

export const metadata: Metadata = {
  title: "Launch Stock-Paired",
  description:
    "A fixed-supply token priced against a tokenized equity on Robinhood Chain, with the swap fee written into the pool at creation.",
};

export default function StockPairedLaunchPage() {
  const model = LAUNCH_MODELS["stock-paired"];

  return (
    <div className="pb-16">
      <section className="aurora px-6 pb-10 pt-16">
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
        <Notice tone="caution" title="The contract path for this model is not finished">
          <p>
            The form below is complete and validates against the same bounds the contracts
            enforce, but the factory still hardcodes ether as the quote side. Four things are
            outstanding:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {model.remaining?.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </Notice>
      </div>

      <LaunchForm modelId="stock-paired" />
    </div>
  );
}
