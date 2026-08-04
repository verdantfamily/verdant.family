/**
 * Copying a string, with the fallback the async API needs.
 *
 * `navigator.clipboard.writeText` is the right call and is not always available. It
 * requires a secure context, it can be refused by permission policy, and it is missing or
 * gated in enough embedded and automated browsers that treating it as the only path means
 * a copy button that silently does nothing for some readers — which is the worst outcome
 * for this control, because there is no way to tell a failed copy from a successful one
 * until you paste.
 *
 * So a refusal falls through to `document.execCommand("copy")`. It is deprecated and it is
 * synchronous and it works essentially everywhere, which is the trade for a feature whose
 * entire job is to put an address somewhere else.
 *
 * Returns whether the text was copied, so a caller can show "Copied" only when it was.
 */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Refused. The fallback below is the whole reason this is not the only attempt.
  }

  return legacyCopy(value);
}

/**
 * The pre-`navigator.clipboard` route: put the text in a selected element and copy it.
 *
 * The textarea has to be in the document and selectable for the command to have anything
 * to act on, so it is positioned off screen rather than hidden — `display: none` and
 * `visibility: hidden` both make a selection impossible. `readOnly` stops a soft keyboard
 * appearing on a phone in the moment before it is removed.
 */
function legacyCopy(value: string): boolean {
  if (typeof document === "undefined") return false;

  const holder = document.createElement("textarea");
  holder.value = value;
  holder.readOnly = true;
  holder.setAttribute("aria-hidden", "true");
  holder.style.position = "fixed";
  holder.style.top = "-9999px";
  holder.style.opacity = "0";

  document.body.appendChild(holder);

  try {
    holder.select();
    holder.setSelectionRange(0, value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    holder.remove();
  }
}
