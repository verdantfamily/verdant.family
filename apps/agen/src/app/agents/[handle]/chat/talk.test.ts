/**
 * The one part of the typing animation that can be checked without a browser.
 *
 * `wholeWords` decides where a partially revealed reply is allowed to end. Get it wrong and
 * every reply on the screen jitters: a word revealed character by character grows until it no
 * longer fits its line, at which point the paragraph reflows to push it down, and a reply of
 * any length spends its whole animation jumping. So the rule is that the visible text always
 * ends on a word boundary, and these are the cases where that is easy to get wrong.
 */

import { describe, expect, it } from "vitest";

import { wholeWords } from "./talk";

describe("agen.space agents — revealing a reply a word at a time", () => {
  it("drops the partial word at the end", () => {
    expect(wholeWords("I have not launched anything yet.", 12)).toBe("I have not");
  });

  it("keeps a word the cut landed exactly at the end of", () => {
    // 6 characters is "I have" and the next character is the space, so nothing is partial.
    expect(wholeWords("I have not", 6)).toBe("I have");
    // 7 is "I have n", one character into a word, so that word goes.
    expect(wholeWords("I have not", 7)).toBe("I have");
  });

  it("shows nothing until there is a whole word", () => {
    expect(wholeWords("Launched", 4)).toBe("");
    expect(wholeWords("Launched", 0)).toBe("");
  });

  /**
   * A reply with no space in it appears all at once.
   *
   * Which is the correct amount of typing to animate over a wallet address: nobody reads one
   * left to right, and revealing it character by character is the exact case that reflows.
   */
  it("reveals an unbroken run in one go rather than a character at a time", () => {
    const address = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
    // Nothing right up to the last character, then the whole of it at once.
    expect(wholeWords(address, address.length - 1)).toBe("");
    expect(wholeWords(address, address.length)).toBe(address);
  });

  it("treats a line break as a boundary, so a paragraph does not hold a half word", () => {
    expect(wholeWords("done.\nNothing else", 11)).toBe("done.");
  });

  it("does not leave trailing whitespace to be revealed as nothing", () => {
    // 11 characters is "I have not " — the space would otherwise be kept and the next frame
    // would appear to reveal an empty word.
    expect(wholeWords("I have not launched", 11)).toBe("I have not");
  });

  it("returns the whole string once every character is asked for", () => {
    const text = "Nothing has traded yet, so I have not repeated it.";
    expect(wholeWords(text, text.length)).toBe(text);
  });
});
