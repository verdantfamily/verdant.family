import { LAUNCH_MODELS } from "@verdant/config";
import type { Metadata } from "next";
import Link from "next/link";

import { LaunchForm } from "../../../components/launch/launch-form";
import { Badge, PageHeading } from "../../../components/primitives";

export const metadata: Metadata = {
  title: "Launch Classic",
  description:
    "A fixed-supply token quoted in ether, with the swap fee written into the pool at creation and the launch position locked by a contract.",
};

export default function ClassicLaunchPage() {
  const model = LAUNCH_MODELS.classic;

  return (
    <div className="pb-16">
      <section className="px-6 pb-12 pt-16">
        <PageHeading
          eyebrow={
            <div className="flex items-center justify-center gap-2">
              <Link
                href="/launch"
                className="text-[0.8rem] text-ink-muted transition-colors hover:text-ink"
              >
                ← Models
              </Link>
              <Badge tone="accent">{model.label}</Badge>
            </div>
          }
          title="Launch Classic"
          lede="Quoted in ether. Supply minted once, the fee written into the pool, the launch position locked. Nothing on this form can be changed after the transaction confirms."
        />
      </section>

      <LaunchForm modelId="classic" />
    </div>
  );
}
