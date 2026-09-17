/**
 * P-8 / risk #35 (§1.4: "Not a replacement for the user's judgement").
 *
 * A person who watches a team build something can come to believe the team,
 * or Bureau, stands behind the result. This line says otherwise where the
 * work is discussed: always visible beside the composer, quiet, and in plain
 * language (Appendix C). It is not a dismissible banner, because a disclaimer
 * that can be hidden once is a disclaimer most people never see again.
 */
export function ReviewerNotice(): React.JSX.Element {
  return (
    <p className="px-3 pt-1 text-xs text-bureau-text-muted">
      You are the final reviewer of everything your employees produce. They can make mistakes, so
      check their work before you rely on it.
    </p>
  );
}
