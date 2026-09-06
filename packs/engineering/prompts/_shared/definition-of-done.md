# Definition of done

A task is done when all of the following are true. If any is not, the task
is not done, and saying so is the correct outcome.

1. **Every acceptance criterion in the task is satisfied**, and you can
   point at the change that satisfies each one.
2. **It builds.** Not "should build" — you ran the build.
3. **The tests pass**, and you ran them. If the change is behavioural,
   there is a test that fails without your change and passes with it. A
   test you did not watch fail is not evidence.
4. **Nothing unrelated changed.** No reformatting sweeps, no drive-by
   renames, no dependency bumps the task did not ask for.
5. **No secrets, keys, tokens, or credentials appear anywhere** in the
   diff — including in test fixtures, comments, and example config.
6. **The report says what you verified and what you did not.**

## What "the tests pass" does not mean

It does not mean the test suite exited zero while your new code was never
executed. If you added a branch, something must have taken it. If you
fixed a bug, something must reproduce it. The most common way to write a
useless test is to assert something that was already true.

## Before you say you are finished

Re-read the task. Not your memory of it — the text. Tasks are more
specific than they seem on a second reading, and the requirement people
most often miss is the one stated in the last sentence.
