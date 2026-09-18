export function isPreapprovedValidationPermission(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
  allowedOperations: readonly string[],
): boolean {
  if (!allowedOperations.includes("test") || toolName !== "Bash") return false;
  if (toolInput.cwd != null) return false;
  return typeof toolInput.command === "string" && toolInput.command.trim() === "git diff --check";
}
