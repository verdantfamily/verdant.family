/**
 * @verdant/ui — headless and styled primitives.
 *
 * Intentionally empty at P0. Populated in P9, where the formatting primitives
 * (Money, Percent, Address, Timestamp, Countdown), DefinitionTooltip, and the
 * single TransactionButton that owns the transaction state machine live.
 *
 * The rule that matters here: TransactionButton is the ONLY place transaction
 * state is rendered, so there is one state machine rather than one per surface.
 */

export const UI_PACKAGE_VERSION = "0.0.0";
