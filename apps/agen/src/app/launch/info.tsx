/**
 * A small "i" that explains the thing it sits next to.
 *
 * Every field on the create screen is asking somebody to make a decision about a market,
 * and the honest explanation of most of them is a sentence too long to sit under the
 * label without turning the page into a document. So the sentence is here, one tap or
 * hover away, and the label stays two words.
 *
 * No state and no positioning library: hover and focus both open it, which means a mouse
 * gets it by pointing, a keyboard gets it by tabbing to the button, and a phone gets it
 * by tapping — because a tap focuses. `aria-describedby` wires the same text to the
 * control it describes, so a screen reader hears the explanation as part of the field
 * rather than as a stray button.
 */
export function Info({ id, children }: { readonly id: string; readonly children: string }) {
  return (
    <span className="info">
      <button type="button" className="info-dot" aria-label="what this means" aria-describedby={id}>
        i
      </button>

      <span className="info-pop" id={id} role="tooltip">
        {children}
      </span>
    </span>
  );
}
