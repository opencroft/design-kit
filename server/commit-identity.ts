// Who a commit in a project's repo is attributed to. No host imports, so it
// runs under `node --test` directly.

/** The name a commit carries when nobody can be named. */
export const UNNAMED_AUTHOR = 'OpenCroft'

/**
 * The name an App action's commits are made under: the signed-in person when
 * the App's own UI called, else the calling agent. Both are bound by the host,
 * so nothing a caller passes can change it. A call that names neither, such as
 * one the host makes on nobody's behalf, gets the unnamed author.
 */
export function committerOf(caller: { callerPerson?: { name: string }; callerAgent?: string }): string {
  return caller.callerPerson?.name ?? caller.callerAgent ?? UNNAMED_AUTHOR
}

/**
 * Git options naming `author` as both author and committer of the one command
 * they precede, with no email. Given per commit rather than written to the
 * repo's config, so the next commit -- someone else's -- never inherits it,
 * and an identity a repo's config still carries is overridden. Git refuses a
 * commit with no email configured, and accepts an empty one.
 */
export function commitAs(author: string): string[] {
  // `<`, `>` and line breaks would corrupt the ident line git writes.
  const name =
    author
      .replace(/[<>\r\n]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || UNNAMED_AUTHOR
  return ['-c', `user.name=${name}`, '-c', 'user.email=']
}
