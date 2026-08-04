import { BRAND } from "../lib/brand";

/** Where the only link on the page goes. */
const X_URL = "https://x.com/verdant_family";

/**
 * The teaser.
 *
 * One screen, no scroll, and exactly one thing to click. There is no navigation because
 * there is nowhere to navigate to yet, and no feature list because a list of features on a
 * page with no product is a promise rather than a description. The mark, the sentence, and
 * a way to hear when it ships.
 *
 * Static, so it renders identically with no server and no data. The photograph and the mark
 * come from `public/brand/`; when they are absent the page falls back to a drawn mark on the
 * moving background, which is a different picture but not a broken one.
 */
export default function Landing() {
  const photo = BRAND.background;

  return (
    <>
      {photo === null ? null : (
        <div className="photo" style={{ backgroundImage: `url(${photo})` }} aria-hidden="true" />
      )}

      <div className="scrim" aria-hidden="true" />

      {/* Light moving over the picture. Two soft gradients on `screen`, drifting slowly
          enough that you notice it only if you stay — which is the point of putting motion
          on a page with one sentence on it. */}
      <div className={photo === null ? "glow bare" : "glow"} aria-hidden="true">
        <span className="glow-a" />
        <span className="glow-b" />
      </div>

      <div className="grain" aria-hidden="true" />

      <div className="stage">
        <header className="top">
          <Mark />
        </header>

        <main className="hero">
          <h1 className="headline">Create markets that evolve.</h1>

          <a className="cta" href={X_URL} target="_blank" rel="noreferrer">
            Follow us on X
          </a>
        </main>

        {/* Small and quiet, because it is the one claim on the page and it should be
            findable without competing with the sentence above it. */}
        <footer className="foot">
          <p>Uniswap v4 hooks, live on Robinhood Chain.</p>
        </footer>
      </div>
    </>
  );
}

/**
 * The mark, however it is available.
 *
 * A lockup is the fallback rather than the first choice: it carries the wordmark, which at
 * the top of a page whose headline is already the brand's whole sentence reads as the name
 * printed twice.
 */
function Mark() {
  if (BRAND.mark !== null) {
    return <img className="mark" src={BRAND.mark} alt="Verdant" />;
  }

  if (BRAND.lockup !== null) {
    return <img className="lockup" src={BRAND.lockup} alt="Verdant" />;
  }

  return <Sprout />;
}

/** The fallback mark, drawn rather than shipped as an image. */
function Sprout() {
  return (
    <span className="sprout" role="img" aria-label="Verdant">
      <svg
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10 17V8.5" />
        <path d="M10 9.5C10 6.2 12.4 3.6 16 3.2c.4 3.6-2.2 6.3-5.4 6.3H10Z" />
        <path d="M10 12.2C10 9.9 8.2 8 5.6 7.7c-.3 2.6 1.6 4.5 3.9 4.5H10Z" />
      </svg>
    </span>
  );
}
