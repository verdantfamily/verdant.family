import Link from "next/link";

import { Bloom } from "../bloom";

/**
 * The three ways to open a market, as a shelf.
 *
 * Create used to land straight on the describe box, which made the AI flow the only thing
 * Agen could do. It is not: a token with no custom logic is a legitimate thing to want,
 * and a creator who wants one should not have to write a sentence about a mechanic they
 * do not have in order to discover that.
 *
 * So the models are shown side by side and named, and the difference between them is
 * stated in one line each rather than inferred from which button is bigger. The artwork
 * is the only part that is not text: three rendered objects that carry the difference
 * before the words are read — a disc standing on a disc, a disc inside an orbit, a disc
 * inside a spiral.
 *
 * ## Why Evergreen is here at all
 *
 * Because it is real and it is not ready, and those are different from absent. The
 * contracts refuse it today — `ModelRegistry` has it disabled, so every Evergreen
 * creation reverts — which is exactly why its card carries a badge and a dead button
 * rather than a link. Hiding it would make the shelf a lie about how many models there
 * are; linking it would make the shelf a lie about what happens next.
 */

interface Model {
  readonly id: string;
  readonly name: string;
  readonly copy: string;
  readonly art: string;
  readonly action: string;
  /** Absent on a model with nowhere to go yet. */
  readonly href?: string;
  /** Marked, but still worth reading about. */
  readonly soon?: boolean;
}

const MODELS: readonly Model[] = [
  {
    id: "instant",
    name: "Instant",
    copy: "Launch a standard token with instant trading. No custom logic, just a clean launch.",
    art: "/instant.png",
    action: "See Instant",
    href: "/launch/instant",
    // Reachable, and not creatable. The hold is on the fee currency rather than on the
    // screen, so the screen explains itself rather than being hidden. See lib/instant.ts.
    soon: true,
  },
  {
    id: "programmable",
    name: "Programmable v4",
    copy: "Describe the behaviour you want in plain English. Agen builds the custom onchain v4 logic.",
    art: "/programmable.png",
    action: "Launch Programmable",
    href: "/launch/programmable",
  },
  {
    id: "evergreen",
    name: "Evergreen",
    copy: "Launch with an upward-only market index. Downside shifts into dynamic supply changes.",
    art: "/evergreen.png",
    action: "Launch Evergreen",
  },
];

export function Models() {
  return (
    <>
      <Bloom active="create" photo="launchbg" centred>
        <h1>Choose your launch model</h1>
      </Bloom>

      <main className="ax-wrap ax-choose">
        <p className="ax-lede">You can choose between 3 launch models</p>

        <div className="ax-models">
          {MODELS.map((model) => (
            <article className="ax-model" key={model.id}>
              {model.href === undefined || model.soon === true ? (
                <span className="ax-model-soon">coming soon</span>
              ) : null}

              <span className="ax-model-art">
                {/* Not next/image: these are three fixed brand renders, already sized,
                    and there is nothing for the optimiser to decide about them. */}
                <img src={model.art} alt="" aria-hidden="true" />
              </span>

              <h2 className="ax-model-name">{model.name}</h2>
              <p className="ax-model-copy">{model.copy}</p>

              {model.href === undefined ? (
                <button type="button" className="ax-model-go" disabled>
                  {model.action}
                </button>
              ) : (
                <Link className="ax-model-go" href={model.href}>
                  {model.action}
                </Link>
              )}
            </article>
          ))}
        </div>

        <footer className="ax-footpanel">
          <div>
            <span className="ax-footmark">
              <img src="/mark.png" width={24} height={24} alt="" aria-hidden="true" />
              agen.space
            </span>
            <p>Tokens whose markets have their own rules</p>
          </div>

          <div className="ax-footlinks">
            <a href="https://x.com/agendotspace" target="_blank" rel="noreferrer">
              Twitter / X
            </a>
            <a href="https://verdant.family" target="_blank" rel="noreferrer">
              Canopy Website
            </a>
            <a href="https://t.me" target="_blank" rel="noreferrer">
              Telegram
            </a>
          </div>
        </footer>
      </main>
    </>
  );
}
