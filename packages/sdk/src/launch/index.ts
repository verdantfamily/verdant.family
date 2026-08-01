/**
 * Building a launch.
 *
 * Two things happen before a creator can send `VerdantFactory.create`, and only one
 * of them is encoding calldata.
 *
 * The other is choosing a salt. A market quoted in an equity requires its token's
 * address to sort above the equity's, because the launch token is always
 * `currency1` (ADR-008), and a token's address is fixed by its salt. So the order
 * is: read the token's init code hash once, search salts locally until one gives a
 * qualifying address, then encode the launch with that salt. `./salt.js` explains
 * why each of those steps is where it is.
 *
 * Nothing here validates a schedule or a bound. `../models/schedule.js` validates
 * schedules and `@verdant/config`'s `BOUNDS` holds the rest, and re-checking them
 * on the way to calldata would be a second implementation of rules that already
 * have two. What this module guarantees is narrower and worth stating plainly: the
 * bytes it produces are the parameters it was given.
 */

export {
  buildCreate,
  encodeCreate,
  TOKEN_SCALE,
  type CreateCall,
  type LaunchParams,
  type UnsignedCall,
} from "./create.js";

export {
  mineTokenSalt,
  predictTokenAddress,
  readTokenInitCodeHash,
  saltFor,
  type MinedSalt,
  type TokenIdentity,
} from "./salt.js";
