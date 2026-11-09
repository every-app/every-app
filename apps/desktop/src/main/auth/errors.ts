export type AuthErrorKind = "signedOut" | "cancelled" | "message";

export class AuthError extends Error {
  constructor(
    readonly kind: AuthErrorKind,
    message = kind === "signedOut" ? "You're signed out. Sign in again." : "Sign-in failed.",
  ) {
    super(message);
    this.name = "AuthError";
  }
}
