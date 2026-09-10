/**
 * AUDIT M0–M2 #16 — the marker that separates "this sentence was written
 * for a person" from "this is our internals leaking".
 *
 * §14.6 requires every error the user sees to be plain language, and names
 * the failure mode exactly: *"'Error: ENOENT' reaching the user is a
 * bug."* The router now translates anything thrown into one fixed
 * sentence, which is right for the general case and **wrong for the small
 * number of errors that are already the right thing to show** — "that
 * first name is taken", "the name pool is exhausted, supply a name", "no
 * such role is installed". Those are the product talking to its user.
 *
 * Three handlers used to do `(err as Error).message` to preserve them, and
 * the comment above one of those catch blocks asserted that the errors
 * "are already written for a person". That was true of the errors the
 * author had in mind and untrue of the `catch` itself, which also caught
 * every SQLite failure and TypeError raised anywhere inside the same
 * `try` — the classic fail-open shape: correct for the case you thought
 * of, silently wrong for the rest.
 *
 * Extending this class is how a domain error opts **in** to being shown.
 * Anything else is translated, which means the safe direction is the
 * default and a new error class has to say something to change that.
 *
 * It lives in `shared/` because both the thrower (`src/main/company`,
 * `src/main/packs`) and the decider (`src/main/ipc/handlers`) need it, and
 * it deliberately carries no code, action or HTTP-ish status — what the
 * user should DO about it is the handler's call, and how it looks is the
 * renderer's.
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
